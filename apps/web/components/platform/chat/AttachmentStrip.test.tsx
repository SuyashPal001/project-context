// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttachmentStrip } from './AttachmentStrip';

const attachment = (name: string, type: string) => ({
  fileId: `id-${name}`,
  name,
  type,
  size: 1234,
});

describe('AttachmentStrip', () => {
  it('labels each attachment with its own type badge, not a generic document', () => {
    render(
      <AttachmentStrip
        attachments={[
          attachment('Rising Dust.mp3', 'audio/mpeg'),
          attachment('spec.pdf', 'application/pdf'),
          attachment('data.csv', 'text/csv'),
        ]}
        pendingUpload={null}
        onRemove={() => {}}
      />,
    );

    expect(screen.getByText('MP3')).toBeDefined();
    expect(screen.getByText('PDF')).toBeDefined();
    expect(screen.getByText('CSV')).toBeDefined();
  });

  // The screenshot case: a csv whose MIME type is uninformative still has to be
  // recognised from its extension rather than falling back to a grey document.
  it('classifies an octet-stream upload from its filename', () => {
    render(
      <AttachmentStrip
        attachments={[attachment('1212-21212-21212-employees.csv', 'application/octet-stream')]}
        pendingUpload={null}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText('CSV')).toBeDefined();
  });

  it('shows the type of a file that is still uploading', () => {
    render(
      <AttachmentStrip
        attachments={[]}
        pendingUpload={{ name: 'brief.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText('DOCX')).toBeDefined();
  });
});
