import { describe, it, expect } from 'vitest';
import { parseFolderId } from './folderScope';

describe('parseFolderId', () => {
    it('drops the literal string "null" — the value that broke retrieval', () => {
        expect(parseFolderId('null')).toBeUndefined();
    });

    it('drops the literal string "undefined" for the same reason', () => {
        expect(parseFolderId('undefined')).toBeUndefined();
    });

    it('drops a hand-typed value that is not a uuid', () => {
        expect(parseFolderId('../../etc')).toBeUndefined();
    });

    it('drops an empty string', () => {
        expect(parseFolderId('')).toBeUndefined();
    });

    it('drops null and undefined', () => {
        expect(parseFolderId(null)).toBeUndefined();
        expect(parseFolderId(undefined)).toBeUndefined();
    });

    it('keeps a real uuid', () => {
        const id = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
        expect(parseFolderId(id)).toBe(id);
    });

    it('keeps an uppercase uuid, which Postgres accepts', () => {
        const id = '3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B';
        expect(parseFolderId(id)).toBe(id);
    });
});
