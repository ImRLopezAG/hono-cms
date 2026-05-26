/**
 * Unit tests for the parity scoring function.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U3
 * test scenarios.
 */

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { scoreImages } from "../diff.ts";

const WIDTH = 32;
const HEIGHT = 32;

function makeSolidPng(
  r: number,
  g: number,
  b: number,
  width = WIDTH,
  height = HEIGHT
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function makePngWithSinglePixelDiff(): Buffer {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }
  // One pixel set to black.
  png.data[0] = 0;
  png.data[1] = 0;
  png.data[2] = 0;
  png.data[3] = 255;
  return PNG.sync.write(png);
}

function makeNoisyPng(seed = 0): Buffer {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  let s = seed === 0 ? 1 : seed;
  for (let i = 0; i < png.data.length; i += 4) {
    // xorshift32 pseudo-random
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const value = Math.abs(s) % 256;
    png.data[i] = value;
    png.data[i + 1] = value;
    png.data[i + 2] = value;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("scoreImages", () => {
  it("returns pass with pixelDelta 0 for identical buffers", () => {
    const buf = makeSolidPng(255, 255, 255);
    const result = scoreImages(buf, buf);
    expect(result.status).toBe("pass");
    expect(result.pixelDelta).toBe(0);
    expect(result.similarityScore).toBe(1);
    expect(result.overlay).not.toBeNull();
  });

  it("returns pass when a single-pixel diff is within threshold", () => {
    const base = makeSolidPng(255, 255, 255);
    const oneOff = makePngWithSinglePixelDiff();
    // 1 / (32*32) = 0.000977 — well below the 0.10 default threshold.
    const result = scoreImages(base, oneOff);
    expect(result.status).toBe("pass");
    expect(result.pixelDelta).toBeGreaterThanOrEqual(1);
    expect(result.pixelDelta).toBeLessThan(5);
    expect(result.similarityScore).toBeGreaterThan(0.99);
  });

  it("returns fail when roughly half the image is noise", () => {
    const base = makeSolidPng(255, 255, 255);
    const noisy = makeNoisyPng(12345);
    const result = scoreImages(base, noisy, { threshold: 0.1 });
    expect(result.status).toBe("fail");
    expect(result.pixelDelta).toBeGreaterThan((WIDTH * HEIGHT) * 0.3);
    expect(result.similarityScore).toBeLessThan(0.9);
  });

  it("returns incomplete when one side is missing without crashing", () => {
    const base = makeSolidPng(255, 255, 255);
    const left = scoreImages(null, base);
    expect(left.status).toBe("incomplete");
    expect(left.pixelDelta).toBe(0);
    expect(left.overlay).toBeNull();
    expect(left.notes).toContain("strapi");

    const right = scoreImages(base, null);
    expect(right.status).toBe("incomplete");
    expect(right.overlay).toBeNull();
    expect(right.notes).toContain("honocms");

    const both = scoreImages(null, null);
    expect(both.status).toBe("incomplete");
  });

  it("honors a custom threshold", () => {
    // Same noisy pair as the fail case, but with a very permissive threshold
    // (1.0 = always pass).
    const base = makeSolidPng(255, 255, 255);
    const noisy = makeNoisyPng(99);
    const result = scoreImages(base, noisy, { threshold: 1.0 });
    expect(result.status).toBe("pass");
  });
});
