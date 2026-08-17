// Smoke test: connect two simulated clients, verify each sees the other,
// verify movement input actually moves a player and gets broadcast.
const { io } = require("socket.io-client");

const URL = "http://localhost:3000";

function connectClient(name, color) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ["websocket"] });
    socket.on("connect", () => {
      socket.emit("join", { name, color }, (init) => {
        resolve({ socket, init });
      });
    });
    socket.on("connect_error", reject);
  });
}

(async () => {
  console.log("Connecting client A...");
  const a = await connectClient("Alice", "red");
  console.log("A joined at", a.init.you.x, a.init.you.y, "map size", a.init.map.width, a.init.map.height);

  console.log("Connecting client B...");
  const b = await connectClient("Bob", "blue");
  console.log("B joined at", b.init.you.x, b.init.you.y);
  console.log("B sees", b.init.players.length, "players in init payload (expect 2)");

  // A should get a player_joined event for B.
  const joinedPromise = new Promise((resolve) => a.socket.once("player_joined", resolve));
  const joined = await joinedPromise;
  console.log("A received player_joined:", joined.name, joined.color);

  // Move B to the right for 1 second, verify A observes B's position change via 'state'.
  const startX = b.init.you.x;
  b.socket.emit("input", { up: false, down: false, left: false, right: true });

  let bLatestFromA = null;
  a.socket.on("state", (list) => {
    const found = list.find((p) => p.id === b.socket.id);
    if (found) bLatestFromA = found;
  });

  await new Promise((r) => setTimeout(r, 1000));
  b.socket.emit("input", { up: false, down: false, left: false, right: false });
  await new Promise((r) => setTimeout(r, 200));

  console.log("B's x moved from", startX, "to (as observed by A):", bLatestFromA && bLatestFromA.x);

  const moved = bLatestFromA && bLatestFromA.x > startX + 1.0;
  console.log(moved ? "PASS: B's movement was broadcast to A and position increased." : "FAIL: movement not observed as expected.");

  // Disconnect B, verify A gets player_left.
  const leftPromise = new Promise((resolve) => a.socket.once("player_left", resolve));
  b.socket.disconnect();
  const leftId = await leftPromise;
  console.log(leftId === joined.id ? "PASS: A received player_left for B." : "FAIL: player_left mismatch.");

  a.socket.disconnect();
  process.exit(moved ? 0 : 1);
})().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
