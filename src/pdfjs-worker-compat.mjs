// Compatibility polyfills for the PDF.js worker runtime on older browsers.
if (typeof Map.prototype.getOrInsert !== "function") {
  Map.prototype.getOrInsert = function getOrInsert(key, defaultValue) {
    if (this.has(key)) return this.get(key);
    this.set(key, defaultValue);
    return defaultValue;
  };
}

if (typeof Map.prototype.getOrInsertComputed !== "function") {
  Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, compute) {
    if (this.has(key)) return this.get(key);
    const value = compute(key);
    this.set(key, value);
    return value;
  };
}

if (typeof Uint8Array.prototype.toHex !== "function") {
  Uint8Array.prototype.toHex = function toHex() {
    let out = "";
    for (let i = 0; i < this.length; i += 1) {
      out += this[i].toString(16).padStart(2, "0");
    }
    return out;
  };
}

import "pdfjs-dist/build/pdf.worker.mjs";
