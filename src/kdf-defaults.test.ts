// knowtarium/protocol can't import crypto, so it keeps its own copy of the default Argon2id work
// factors (the sync API fakes prelogin answers with them). This file sits outside both modules and
// keeps the two copies equal.
import { describe, expect, it } from "vitest";

import { DEFAULT_KDF_MEM_LIMIT, DEFAULT_KDF_OPS_LIMIT } from "./crypto/index.js";
import {
  DEFAULT_KDF_MEM_LIMIT_BYTES,
  DEFAULT_KDF_OPS_LIMIT as PROTOCOL_DEFAULT_KDF_OPS_LIMIT,
  KdfParams,
} from "./protocol/index.js";

describe("default KDF parameters", () => {
  it("are the same in knowtarium/protocol and knowtarium/crypto", () => {
    expect(PROTOCOL_DEFAULT_KDF_OPS_LIMIT).toBe(DEFAULT_KDF_OPS_LIMIT);
    expect(DEFAULT_KDF_MEM_LIMIT_BYTES).toBe(DEFAULT_KDF_MEM_LIMIT);
  });

  it("fit the protocol's KdfParams schema", () => {
    const params = {
      algorithm: "argon2id13",
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      opsLimit: PROTOCOL_DEFAULT_KDF_OPS_LIMIT,
      memLimitBytes: DEFAULT_KDF_MEM_LIMIT_BYTES,
    };
    expect(KdfParams.safeParse(params).success).toBe(true);
  });
});
