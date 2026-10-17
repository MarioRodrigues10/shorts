// Minimal DOM so engine modules (and the libraries they import) load under `bun test`.
const node = () => ({ appendChild() {}, insertBefore() {}, setAttribute() {}, removeChild() {}, style: {}, getContext: () => null });
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document = {
  head: node(), body: node(), createElement: node, createTextNode: node,
  getElementsByTagName: () => [node()], addEventListener() {}, querySelector: () => null,
};
