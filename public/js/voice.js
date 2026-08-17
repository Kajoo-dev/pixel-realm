// Proximity voice chat: always-on mic, peer-to-peer audio via WebRTC,
// volume falls off linearly with tile distance (100% at 0 tiles, 0% at
// 10+ tiles). The server only relays signaling messages (see
// "voice-signal" in server/index.js); audio itself flows directly
// between browsers.
window.VoiceChat = (() => {
  "use strict";

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  const MAX_DISTANCE = 10; // tiles: volume hits 0 at this distance (11+ is silent)
  const VOLUME_UPDATE_MS = 150;

  let socket = null;
  let myId = null;
  let distanceFn = () => null;
  let statusCb = () => {};
  let localStream = null;
  let micEnabled = true;
  let volumeTimer = null;

  /** id -> { pc, audioEl, pendingCandidates, connected } */
  const peers = new Map();

  function computeVolume(distance) {
    if (distance == null || Number.isNaN(distance)) return 0;
    return Math.max(0, Math.min(1, 1 - distance / MAX_DISTANCE));
  }

  function send(to, voiceType, data) {
    if (!socket) return;
    socket.emit("voice-signal", { to, voiceType, data });
  }

  async function flushPendingCandidates(peer) {
    const pending = peer.pendingCandidates.splice(0);
    for (const c of pending) {
      try { await peer.pc.addIceCandidate(c); } catch (e) { /* stale candidate, ignore */ }
    }
  }

  function createPeer(id, isInitiator) {
    if (peers.has(id)) return peers.get(id);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.dataset.peerId = id;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);

    const peer = { pc, audioEl, pendingCandidates: [], connected: false };
    peers.set(id, peer);

    // Always negotiate an audio m-line, even if we have no mic locally,
    // so the other side can still send to us regardless of who has
    // microphone access.
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) send(id, "ice", e.candidate);
    };
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      peer.connected = pc.connectionState === "connected";
    };

    if (isInitiator) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send(id, "offer", pc.localDescription);
        } catch (err) {
          console.warn("voice: failed to create offer for", id, err);
        }
      })();
    }

    return peer;
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    try { peer.pc.close(); } catch (e) { /* noop */ }
    if (peer.audioEl.parentNode) peer.audioEl.parentNode.removeChild(peer.audioEl);
    peers.delete(id);
  }

  function startVolumeLoop() {
    stopVolumeLoop();
    volumeTimer = setInterval(() => {
      for (const [id, peer] of peers) {
        const dist = distanceFn(id);
        const vol = computeVolume(dist);
        peer.audioEl.volume = vol;
        peer.audioEl.muted = vol <= 0.001;
      }
    }, VOLUME_UPDATE_MS);
  }

  function stopVolumeLoop() {
    if (volumeTimer) clearInterval(volumeTimer);
    volumeTimer = null;
  }

  async function requestMic() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      statusCb({ state: "ready" });
    } catch (err) {
      localStream = null;
      statusCb({ state: "denied", error: err });
    }
  }

  /**
   * opts: { socket, myId, distanceFn, statusCb }
   * distanceFn(peerId) => tile distance to that player, or null if unknown.
   *
   * IMPORTANT: signaling listeners are registered synchronously, before
   * anything is awaited. If we awaited mic permission first, a peer who
   * joined moments earlier could send their offer before we're listening
   * for it — socket.io doesn't queue events for listeners that don't
   * exist yet, so that offer would just be silently lost and the two
   * clients would never connect. Both the initiator and answerer paths
   * below await the *same* micReady promise right before touching the
   * peer connection, so mic resolution (granted or denied) never races
   * against a message that already arrived.
   */
  function init(opts) {
    socket = opts.socket;
    myId = opts.myId;
    distanceFn = opts.distanceFn || distanceFn;
    statusCb = opts.statusCb || statusCb;

    statusCb({ state: "requesting" });
    const micReady = requestMic();

    // Only the player who was already in the room initiates the offer
    // toward a newly-joined player. This makes initiation direction
    // unambiguous (no glare / simultaneous-offer race), since a
    // newly-joined client never receives its own "player_joined" event.
    socket.on("player_joined", (p) => {
      if (p.id === myId) return;
      micReady.then(() => createPeer(p.id, true));
    });

    socket.on("player_left", (id) => removePeer(id));

    socket.on("voice-signal", async (msg) => {
      const { from, voiceType, data } = msg || {};
      if (!from || !voiceType) return;
      await micReady;

      if (voiceType === "offer") {
        const peer = createPeer(from, false);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
        await flushPendingCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        send(from, "answer", peer.pc.localDescription);
      } else if (voiceType === "answer") {
        const peer = peers.get(from);
        if (!peer) return;
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
        await flushPendingCandidates(peer);
      } else if (voiceType === "ice") {
        const peer = peers.get(from);
        if (!peer) return;
        if (peer.pc.remoteDescription) {
          try { await peer.pc.addIceCandidate(data); } catch (e) { /* ignore */ }
        } else {
          peer.pendingCandidates.push(data);
        }
      }
    });

    startVolumeLoop();
    return micReady;
  }

  function setMicEnabled(enabled) {
    micEnabled = enabled;
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => { t.enabled = enabled; });
    }
  }

  function isMicEnabled() { return micEnabled; }
  function hasMic() { return !!localStream; }
  function peerCount() { return peers.size; }
  function audiblePeerCount() {
    let n = 0;
    for (const [, peer] of peers) if (!peer.audioEl.muted) n += 1;
    return n;
  }

  // Exposed for automated testing/debugging only.
  function debugInfo() {
    const out = [];
    for (const [id, peer] of peers) {
      out.push({
        id,
        connectionState: peer.pc.connectionState,
        iceState: peer.pc.iceConnectionState,
        volume: peer.audioEl.volume,
        muted: peer.audioEl.muted,
        hasRemoteTrack: !!peer.audioEl.srcObject,
      });
    }
    return out;
  }

  return { init, setMicEnabled, isMicEnabled, hasMic, peerCount, audiblePeerCount, debugInfo };
})();
