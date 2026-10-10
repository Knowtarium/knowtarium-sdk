/**
 * The libsodium functions the clip format and the pairing use, all in both libsodium builds: the
 * standard `libsodium-wrappers` that `knowtarium/clip` loads (src/clip/sodium.ts), and the sumo
 * build the rest of the package uses (src/crypto/sodium.ts), which passes itself in to the same
 * code. Nothing here opens a sealed box: that takes the inbox private key, which only
 * `knowtarium/client` derives.
 */
export interface ClipSodium {
  crypto_sign_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_sign_detached(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_sign_verify_detached(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ): boolean;
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_generichash(hashLength: number, message: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_kdf_derive_from_key(
    subkeyLength: number,
    subkeyId: number,
    context: string,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  pad(buf: Uint8Array, blocksize: number): Uint8Array;
  randombytes_buf(length: number): Uint8Array;
  memzero(bytes: Uint8Array): void;
}
