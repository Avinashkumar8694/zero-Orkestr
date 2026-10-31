import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiBase } from '../api/api-base';

export interface EphemeralPublicKeyResponse {
  publicKey: string;
  algorithm: string;
  hash: string;
}

@Injectable({ providedIn: 'root' })
export class CryptoService extends ApiBase {
  private cachedKeyPromise: Promise<CryptoKey> | null = null;

  /** Fetches the ephemeral public key from backend and imports it into WebCrypto */
  async getPublicKey(): Promise<CryptoKey> {
    if (this.cachedKeyPromise) return this.cachedKeyPromise;

    this.cachedKeyPromise = (async () => {
      const resp = await firstValueFrom(
        this.http.get<EphemeralPublicKeyResponse>(`${this.base}/crypto/public-key`)
      );
      return this.importPublicKeyPem(resp.publicKey);
    })().catch((err) => {
      this.cachedKeyPromise = null; // allow retry on next call
      throw err;
    });

    return this.cachedKeyPromise;
  }

  /** Imports an SPKI PEM public key into a WebCrypto CryptoKey */
  private async importPublicKeyPem(pem: string): Promise<CryptoKey> {
    const pemHeader = '-----BEGIN PUBLIC KEY-----';
    const pemFooter = '-----END PUBLIC KEY-----';
    const b64 = pem
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\s/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return window.crypto.subtle.importKey(
      'spki',
      bytes.buffer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
  }

  /**
   * Encrypts a sensitive string using RSA-OAEP SHA-256 with the server's ephemeral public key.
   * Prepends 'enc:rsa:oaep:' to identify the ciphertext to backend.
   */
  async encryptSecret(plaintext: string): Promise<string> {
    if (!plaintext) return plaintext;
    try {
      if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
        return plaintext;
      }
      const key = await this.getPublicKey();
      const enc = new TextEncoder();
      const encoded = enc.encode(plaintext);
      const encryptedBuffer = await window.crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        key,
        encoded
      );
      const bytes = new Uint8Array(encryptedBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);
      return `enc:rsa:oaep:${b64}`;
    } catch (err) {
      console.warn('In-transit RSA encryption fell back:', err);
      return plaintext;
    }
  }
}
