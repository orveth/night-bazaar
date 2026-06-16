// INTERNAL DEV SCRIPT: not part of the game; holds a ws session for manual gate payment via CLI.
/**
 * Hold a ws session open so an external payer (pop-pay CLI) can pay gates
 * against it: prints the session id, then logs entitlement/error/prize
 * messages until the timeout.
 *
 *   bun scripts/session-hold.ts <serverBase> [seconds]
 */

export {}; // module-ness under tsc

const [serverBase, secondsRaw] = process.argv.slice(2);
if (!serverBase) {
  console.error("usage: bun scripts/session-hold.ts <serverBase> [seconds]");
  process.exit(2);
}
const seconds = Number.parseInt(secondsRaw ?? "90", 10);

const ws = new WebSocket(`${serverBase.replace(/^http/, "ws")}/ws`);
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
  if (m.type === "hello") {
    console.log(`SESSION=${m.session}`);
  } else if (m.type !== "state") {
    console.log(`MSG=${JSON.stringify(m)}`);
  }
};
ws.onclose = () => {
  console.log("CLOSED");
  process.exit(0);
};
setTimeout(() => {
  ws.close();
}, seconds * 1000);
