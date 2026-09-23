/**
 * Minimal OpenTUI React entry point proving the Bun + OpenTUI runtime path
 * before the real TUI is built in chunks 6–7.
 *
 * `bun run src/index.tsx --smoke` renders briefly and exits, which is the
 * form used by the PTY compatibility check.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";

function App(props: { readonly onQuit: () => void }) {
  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      props.onQuit();
    }
  });

  return (
    <box flexDirection="column" border padding={1}>
      <text>MMStar OpenRouter runner</text>
      <text>Workspace foundation smoke screen. Press q to quit.</text>
      <text>Engine, TUI, and recovery commands land in later chunks.</text>
    </box>
  );
}

const smoke = process.argv.includes("--smoke");
const renderer = await createCliRenderer();
const root = createRoot(renderer);

let quitRequested = false;
const quit = (): void => {
  if (quitRequested) {
    return;
  }
  quitRequested = true;
  root.unmount();
  renderer.destroy();
  process.exit(0);
};

root.render(<App onQuit={quit} />);

if (smoke) {
  setTimeout(quit, 250);
}
