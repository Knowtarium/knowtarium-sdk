import { beforeAll, describe, expect, it } from "vitest";

import { formatRecoveryCode, generateRecoveryKey, parseRecoveryCode } from "./recovery-code.js";
import { ready } from "./sodium.js";

beforeAll(ready);

describe("recovery codes", () => {
  it("formats 32 random bytes as 14 groups of 4 and parses them back", () => {
    const key = generateRecoveryKey();
    const code = formatRecoveryCode(key);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){13}$/);
    expect(parseRecoveryCode(code)).toEqual(key);
    expect(formatRecoveryCode(generateRecoveryKey())).not.toBe(code);
  });

  it("forgives case, spacing, missing dashes and O/I/L look-alikes", () => {
    const key = generateRecoveryKey();
    const code = formatRecoveryCode(key);
    const sloppy = code
      .toLowerCase()
      .replaceAll("-", " ")
      .replaceAll("0", "o")
      .replaceAll("1", "l");
    expect(parseRecoveryCode(` ${sloppy} `)).toEqual(key);
    expect(parseRecoveryCode(code.replaceAll("-", ""))).toEqual(key);
  });

  it("catches every single-character typo", () => {
    const code = formatRecoveryCode(generateRecoveryKey());
    for (let index = 0; index < code.length; index++) {
      if (code[index] === "-") continue;
      const typo = code.slice(0, index) + (code[index] === "Z" ? "Y" : "Z") + code.slice(index + 1);
      expect(() => parseRecoveryCode(typo), `position ${String(index)}`).toThrow(
        expect.objectContaining({ code: "invalid_recovery_code" }),
      );
    }
  });

  it("catches swapped neighbours", () => {
    const code = formatRecoveryCode(generateRecoveryKey()).replaceAll("-", "");
    let index = 0;
    while (code.charAt(index) === code.charAt(index + 1)) index++;
    const swapped =
      code.slice(0, index) + code.charAt(index + 1) + code.charAt(index) + code.slice(index + 2);
    expect(() => parseRecoveryCode(swapped)).toThrow(
      expect.objectContaining({ code: "invalid_recovery_code" }),
    );
  });

  it("doesn't echo the code in its error", () => {
    const code = formatRecoveryCode(generateRecoveryKey());
    let message = "";
    try {
      parseRecoveryCode(`${code}X`);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("not a valid recovery code");
    expect(message).not.toContain(code.slice(0, 9));
  });
});
