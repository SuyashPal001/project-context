import { describe, it, expect } from 'vitest';
import {
  UPLOAD_GUIDANCE,
  SUPPORTED_UPLOAD_EXTENSIONS,
  buildPlatformPrompt,
  buildResearchEngineerPrompt,
  withUploadGuidance,
} from '../lib/agentPrompts';

describe('UPLOAD_GUIDANCE', () => {
  it('tells the agent that users attach files directly in chat', () => {
    expect(UPLOAD_GUIDANCE).toMatch(/attach .*files .*(in|to) (the )?chat/i);
  });

  it('names the paperclip control the user actually has to click', () => {
    expect(UPLOAD_GUIDANCE).toContain('paperclip');
  });

  it('lists every extension the upload pipeline accepts', () => {
    for (const ext of SUPPORTED_UPLOAD_EXTENSIONS) {
      expect(UPLOAD_GUIDANCE).toContain(ext);
    }
  });

  it('says a zip is unpacked rather than rejected', () => {
    expect(UPLOAD_GUIDANCE).toMatch(/\.zip.*unpack/is);
  });

  it('forbids redirecting users to external file transfer services', () => {
    expect(UPLOAD_GUIDANCE).toMatch(/never.*cannot receive files/is);
    expect(UPLOAD_GUIDANCE).toContain('WeTransfer');
  });
});

describe('withUploadGuidance', () => {
  it('keeps the agent-specific prompt it wraps', () => {
    expect(withUploadGuidance('You are the Architect.')).toContain('You are the Architect.');
  });

  it('appends the shared upload guidance', () => {
    expect(withUploadGuidance('You are the Architect.')).toContain(UPLOAD_GUIDANCE);
  });

  it('does not append the guidance twice to an already-wrapped prompt', () => {
    const once = withUploadGuidance('You are the Architect.');

    const twice = withUploadGuidance(once);

    expect(twice).toBe(once);
  });
});

describe('buildPlatformPrompt', () => {
  it('carries the upload guidance so agents without an override inherit it', () => {
    expect(buildPlatformPrompt()).toContain(UPLOAD_GUIDANCE);
  });

  it('is not the bare fallback assistant string', () => {
    expect(buildPlatformPrompt()).not.toBe('You are Disco, a helpful AI assistant.');
  });
});

describe('buildResearchEngineerPrompt', () => {
  it('addresses the agent to the workspace it serves', () => {
    expect(buildResearchEngineerPrompt('Acme')).toContain('Research Engineer for Acme');
  });

  it('still instructs retrieval before answering', () => {
    expect(buildResearchEngineerPrompt('Acme')).toContain('retrieve_documents');
  });

  it('leaves upload guidance to the shared wrapper rather than duplicating it', () => {
    expect(buildResearchEngineerPrompt('Acme')).not.toContain(UPLOAD_GUIDANCE);
  });
});
