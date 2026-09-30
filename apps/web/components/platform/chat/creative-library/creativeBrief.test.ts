import { describe, expect, it } from 'vitest';
import {
    buildCreativeBriefMessage,
    countCreativeBriefAttachments,
    creativeBriefAttachmentIds,
    creativeMessageDisplayText,
    mergeCreativeBriefAttachments,
    parseCreativeBriefDraft,
    parseCreativeBriefPresentation,
} from './creativeBrief';
import {
    createEmptyCreativeBrief,
    updateCreativeBrief,
    type CreativeBrief,
    type ProductRecordSelection,
} from './creativeBriefModel';

const avatarAttachment = { fileId: 'avatar-file', name: 'arjun.jpg', type: 'image/jpeg', size: 120 };
const productAttachment = { fileId: 'product-file', name: 'serum.png', type: 'image/png', size: 240 };

function completeBrief(): CreativeBrief {
    return {
        template: { kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', image: '/creative/templates/product-demo.png' },
        avatar: { kind: 'avatar', id: 'arjun', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', attachment: avatarAttachment },
        product: { kind: 'product-image', id: 'product-file', name: 'serum.png', attachment: productAttachment },
        voice: { kind: 'voice', id: 'nandi-id', name: 'Nandi', tagline: 'Poised narrator', language: 'hi', languageLabel: 'Hindi' },
    };
}

describe('creative brief', () => {
    it('keeps one selection per field and replaces only that field', () => {
        const first = updateCreativeBrief(createEmptyCreativeBrief(), { kind: 'template', id: 'one', title: 'One', category: 'Demo', image: '/creative/templates/one.png' });
        const withAvatar = updateCreativeBrief(first, { kind: 'avatar', id: 'arjun', name: 'Arjun', role: 'Host', tone: 'Clear', attachment: avatarAttachment });
        const replaced = updateCreativeBrief(withAvatar, { kind: 'template', id: 'two', title: 'Two', category: 'UGC', image: '/creative/templates/two.png' });
        expect(replaced.template?.id).toBe('two');
        expect(replaced.avatar?.id).toBe('arjun');
    });

    it('builds a deterministic request with real provider identifiers', () => {
        const message = buildCreativeBriefMessage('Make a 20-second Instagram ad.', completeBrief());
        expect(message).toContain('User direction:\nMake a 20-second Instagram ad.');
        expect(message).toContain('- Template: Product Demo (Demonstration)');
        expect(message).toContain('- Avatar: Arjun · Tech presenter · Clear');
        expect(message).toContain('- Product: serum.png');
        expect(message).toContain('Voice ID: nandi-id');
        expect(message).toContain('Narration language: Hindi (hi)');
        expect(message).toContain('Do not invent product claims');
    });

    it('marks an Animation or TVC avatar so Olmo keeps its look, and leaves a UGC avatar line unchanged', () => {
        const base = { kind: 'avatar' as const, id: 'x', name: 'Lumo', role: 'Cozy 3D mascot · felt lantern', tone: 'Shy & hopeful', attachment: avatarAttachment };
        const animated = buildCreativeBriefMessage('', updateCreativeBrief(createEmptyCreativeBrief(), { ...base, category: 'Animation' }));
        expect(animated).toContain('- Avatar: Lumo · Cozy 3D mascot · felt lantern · Shy & hopeful');
        expect(animated).toContain('Avatar category: Animation — an animated character.');
        const tvc = buildCreativeBriefMessage('', updateCreativeBrief(createEmptyCreativeBrief(), { ...base, name: 'Aroha', category: 'TVC' }));
        expect(tvc).toContain('Avatar category: TVC');
        const ugc = buildCreativeBriefMessage('', updateCreativeBrief(createEmptyCreativeBrief(), { ...base, name: 'Arjun' }));
        expect(ugc).not.toContain('Avatar category');
    });

    it('builds a request from any subset of creative selections', () => {
        const brief = updateCreativeBrief(createEmptyCreativeBrief(), {
            kind: 'voice', id: 'lauren-id', name: 'Lauren', language: 'en', languageLabel: 'English',
        });
        const message = buildCreativeBriefMessage('', brief);

        expect(message).toContain('- Voice: Lauren');
        expect(message).not.toContain('- Template:');
        expect(message).not.toContain('- Avatar:');
        expect(message).not.toContain('- Product:');
    });

    it('round-trips durable transcript presentation without exposing the agent brief', () => {
        const brief = completeBrief();
        const message = buildCreativeBriefMessage('Make it upbeat → then close with “Shop now”.', brief);
        const presentation = parseCreativeBriefPresentation(message);

        expect(presentation).toEqual({ direction: 'Make it upbeat → then close with “Shop now”.', brief });
        expect(creativeMessageDisplayText(message)).toBe('Make it upbeat → then close with “Shop now”.');
        expect(creativeBriefAttachmentIds(brief)).toEqual(new Set(['avatar-file', 'product-file']));
    });

    it('does not interpret malformed transcript metadata', () => {
        const malformed = 'Creative brief:\n<!-- olmo-creative-brief:v1:%ZZ -->';
        expect(parseCreativeBriefPresentation(malformed)).toBeNull();
        expect(creativeMessageDisplayText(malformed)).toBe(malformed);
    });

    it('rejects untrusted image paths from persisted and transcript data', () => {
        const brief = completeBrief();
        const unsafeBrief = { ...brief, template: { ...brief.template!, image: 'https://untrusted.example/image.jpg' } };
        expect(parseCreativeBriefDraft(JSON.stringify(unsafeBrief)).template).toBeNull();

        const unsafeMessage = buildCreativeBriefMessage('Create it.', unsafeBrief);
        const presentation = parseCreativeBriefPresentation(unsafeMessage);
        expect(presentation?.brief.template).toBeNull();
        expect(presentation?.brief.avatar?.name).toBe('Arjun');
    });

    it('deduplicates existing and brief attachments by fileId', () => {
        const attachments = mergeCreativeBriefAttachments([avatarAttachment], completeBrief());
        expect(attachments).toEqual([avatarAttachment, productAttachment]);
    });

    it('counts a pending recording alongside deduplicated creative attachments', () => {
        expect(countCreativeBriefAttachments([avatarAttachment], completeBrief(), true)).toBe(3);
    });

    it('still parses a historical message annotation that carries the old prompt field', () => {
        // Simulates a chat message persisted before this change shipped — its
        // JSON still has `prompt` on the template selection. isTemplateSelection
        // must accept this without requiring `prompt`, or every past templated
        // message stops rendering the moment this ships.
        const legacyBrief = {
            template: { kind: 'template', id: 'demo', title: 'Product Demo', category: 'Demonstration', prompt: 'Show it.', image: '/creative/templates/product-demo.png' },
            avatar: null, product: null, voice: null,
        };
        const encoded = encodeURIComponent(JSON.stringify({ direction: 'Make an ad', brief: legacyBrief })).replaceAll('-', '%2D');
        const content = `some direction text\n\n<!-- olmo-creative-brief:v1:${encoded} -->`;

        const parsed = parseCreativeBriefPresentation(content);

        expect(parsed).not.toBeNull();
        expect(parsed!.brief.template).toEqual(
            expect.objectContaining({ id: 'demo', title: 'Product Demo', category: 'Demonstration' }),
        );
    });

    it('restores valid drafts and discards malformed persisted values', () => {
        const brief = completeBrief();
        expect(parseCreativeBriefDraft(JSON.stringify(brief))).toEqual(brief);
        expect(parseCreativeBriefDraft('{bad json')).toEqual(createEmptyCreativeBrief());
        expect(parseCreativeBriefDraft(JSON.stringify({ ...brief, avatar: { kind: 'avatar' } })).avatar).toBeNull();
    });
});

type UrlProduct = Extract<NonNullable<CreativeBrief['product']>, { kind: 'product-url' }>;

describe('imported product-url wiring', () => {
  const importedBrief: CreativeBrief = {
    template: null,
    avatar: null,
    voice: null,
    product: {
      kind: 'product-url',
      id: 'https://shop.example.com/p/1',
      name: 'shop.example.com',
      url: 'https://shop.example.com/p/1',
      imported: {
        title: 'Ceramic Mug',
        description: 'A sturdy 12oz mug.',
        price: '19.00 USD',
        images: [{ fileId: 'file-1', name: 'mug.jpg', type: 'image/jpeg', size: 1024 }],
        selectedImageId: 'file-1',
      },
    },
  };

  it('includes the imported title, description, and price in the product line', () => {
    const message = buildCreativeBriefMessage('', importedBrief);
    expect(message).toContain('- Product: Ceramic Mug (https://shop.example.com/p/1) — A sturdy 12oz mug. — 19.00 USD');
    expect(message).toContain('19.00 USD');
  });

  it('leads with the edited imported title, drops the stale name, and never repeats the title', () => {
    const edited: CreativeBrief = {
      ...importedBrief,
      product: { ...(importedBrief.product as UrlProduct), name: 'Home | Shop', imported: { ...(importedBrief.product as UrlProduct).imported!, title: 'Ceramic Mug' } },
    };
    const line = buildCreativeBriefMessage('', edited).split('\n').find(l => l.startsWith('- Product:'))!;
    expect(line).not.toContain('Home | Shop');
    expect(line.match(/Ceramic Mug/g)).toHaveLength(1);
    expect(line).toContain('A sturdy 12oz mug.');
    expect(line).toContain('19.00 USD');
  });

  it('falls back to name when the imported title is blank', () => {
    const blank: CreativeBrief = {
      ...importedBrief,
      product: { ...(importedBrief.product as UrlProduct), name: 'shop.example.com', imported: { ...(importedBrief.product as UrlProduct).imported!, title: '  ' } },
    };
    expect(buildCreativeBriefMessage('', blank)).toContain('- Product: shop.example.com (https://shop.example.com/p/1) — A sturdy');
  });

  it('drops a malformed imported field without throwing, keeping the link-only selection', () => {
    // Tamper with the persisted marker itself, as a corrupted stored message would be.
    const marker = (imported: unknown) => {
      const prefix = '<!-- olmo-creative-brief:v1:';
      const good = buildCreativeBriefMessage('', importedBrief);
      const start = good.lastIndexOf(prefix) + prefix.length;
      const payload = JSON.parse(decodeURIComponent(good.slice(start, -' -->'.length)));
      payload.brief.product.imported = imported;
      return `${good.slice(0, start)}${encodeURIComponent(JSON.stringify(payload)).replaceAll('-', '%2D')} -->`;
    };
    for (const bad of [
      { title: 'x', description: null, price: null, images: 'nope', selectedImageId: 'file-1' },
      { title: 5, description: null, price: null, images: [], selectedImageId: null },
      { title: null, description: null, price: null, images: [{ fileId: 1 }], selectedImageId: null },
      'junk',
    ]) {
      const parsed = parseCreativeBriefPresentation(marker(bad));
      expect(parsed?.brief.product?.kind).toBe('product-url');
      expect((parsed?.brief.product as UrlProduct).imported).toBeUndefined();
      expect(() => creativeBriefAttachmentIds(parsed!.brief)).not.toThrow();
    }
  });

  it('round-trips a valid imported field unchanged through encode/parse', () => {
    const parsed = parseCreativeBriefPresentation(buildCreativeBriefMessage('hi', importedBrief));
    expect(parsed?.brief.product).toEqual(importedBrief.product);
  });

  it('tells the agent to use the attached image when a selected image is present', () => {
    const message = buildCreativeBriefMessage('', importedBrief);
    expect(message).toContain('Use the attached product image as the visual reference.');
  });

  it('keeps the "inspect the URL" instruction when no image is selected', () => {
    const noImageBrief: CreativeBrief = {
      ...importedBrief,
      product: { ...importedBrief.product!, imported: { ...(importedBrief.product as any).imported, selectedImageId: null } } as any,
    };
    const message = buildCreativeBriefMessage('', noImageBrief);
    expect(message).toContain('Treat the URL as a source to inspect');
  });

  it('falls back to name-and-url when imported is absent (unchanged behavior)', () => {
    const linkOnlyBrief: CreativeBrief = {
      ...importedBrief,
      product: { kind: 'product-url', id: 'https://x.example.com', name: 'x.example.com', url: 'https://x.example.com' },
    };
    const message = buildCreativeBriefMessage('', linkOnlyBrief);
    expect(message).toContain('x.example.com (https://x.example.com)');
  });

  it('creativeBriefAttachmentIds includes the selected imported image, so it is hidden from the plain attachment list', () => {
    expect(creativeBriefAttachmentIds(importedBrief).has('file-1')).toBe(true);
  });

  it('creativeBriefAttachmentIds is empty when no image is selected', () => {
    const noImageBrief: CreativeBrief = {
      ...importedBrief,
      product: { ...importedBrief.product!, imported: { ...(importedBrief.product as any).imported, selectedImageId: null } } as any,
    };
    expect(creativeBriefAttachmentIds(noImageBrief).size).toBe(0);
  });

  it('mergeCreativeBriefAttachments actually attaches the selected imported image', () => {
    const merged = mergeCreativeBriefAttachments(undefined, importedBrief);
    expect(merged).toEqual([{ fileId: 'file-1', name: 'mug.jpg', type: 'image/jpeg', size: 1024 }]);
  });

  it('mergeCreativeBriefAttachments attaches nothing for product-url when no image is selected', () => {
    const noImageBrief: CreativeBrief = {
      ...importedBrief,
      product: { ...importedBrief.product!, imported: { ...(importedBrief.product as any).imported, selectedImageId: null } } as any,
    };
    expect(mergeCreativeBriefAttachments(undefined, noImageBrief)).toBeUndefined();
  });

  it('dedupes if the selected imported image happens to already be in existing attachments', () => {
    const merged = mergeCreativeBriefAttachments(
      [{ fileId: 'file-1', name: 'mug.jpg', type: 'image/jpeg', size: 1024 }],
      importedBrief,
    );
    expect(merged).toHaveLength(1);
  });
});

const productRecord = (over: Partial<ProductRecordSelection> = {}): ProductRecordSelection => ({
    kind: 'product', id: 'p1', name: 'The Ordinary Niacinamide serum', category: null, description: 'A white dropper bottle.',
    price: '₹590', sourceUrl: 'https://theordinary.com/p/1', usps: [], namingStatus: 'done',
    attachment: { fileId: 'f1', name: 'serum.png', type: 'image/png', size: 3 }, ...over,
});

describe('product record selections', () => {
    it('sends the name, description, price and source, and says an image is attached', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord() };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).toContain('- Product: The Ordinary Niacinamide serum\n  A white dropper bottle. ₹590\n  Source: https://theordinary.com/p/1\n  Use the attached product image as the visual reference.');
    });

    it('omits empty optional lines', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ description: null, price: null, sourceUrl: null }) };
        expect(buildCreativeBriefMessage('', brief)).toContain('- Product: The Ordinary Niacinamide serum\n  Use the attached product image as the visual reference.');
    });

    it('includes category and selling points when set', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ category: 'Beauty & Personal Care', usps: ['Vegan', 'Fragrance-free'] }) };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).toContain('  Category: Beauty & Personal Care');
        expect(message).toContain('  Selling points: Vegan; Fragrance-free');
    });

    it('omits category and selling-points lines when absent', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ description: null, price: null, sourceUrl: null }) };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).not.toContain('Category:');
        expect(message).not.toContain('Selling points:');
    });

    it('tells Olmo to ask when the name is not known yet', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ name: 'Untitled product', namingStatus: 'pending', description: null, price: null, sourceUrl: null }) };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).toContain('- Product: name not known yet — ask the user what this product is before planning.');
        expect(message).not.toContain('Untitled product\n');
    });

    it('keeps price and source even while the name is still pending', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ name: 'Untitled product', namingStatus: 'pending' }) };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).toContain(
            '- Product: name not known yet — ask the user what this product is before planning.\n'
            + '  A white dropper bottle. ₹590\n'
            + '  Source: https://theordinary.com/p/1\n'
            + '  Use the attached product image as the visual reference.'
        );
    });

    it('attaches the main image and hides it from the transcript as a brief attachment', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord() };
        expect(mergeCreativeBriefAttachments(undefined, brief)).toEqual([productRecord().attachment]);
        expect(creativeBriefAttachmentIds(brief)).toEqual(new Set(['f1']));
    });

    it('attaches nothing and omits the "attached image" line for a manually-created product with no photo yet', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ attachment: undefined }) };
        expect(mergeCreativeBriefAttachments(undefined, brief)).toBeUndefined();
        expect(creativeBriefAttachmentIds(brief)).toEqual(new Set());
        expect(buildCreativeBriefMessage('', brief)).not.toContain('Use the attached product image');
    });

    it('round-trips through the persisted draft', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord() };
        expect(parseCreativeBriefDraft(JSON.stringify(brief)).product).toEqual(productRecord());
    });

    it('round-trips a manually-created record with no image yet (attachment omitted)', () => {
        const noImage = { ...productRecord(), attachment: undefined };
        const brief = { ...createEmptyCreativeBrief(), product: noImage };
        const parsed = parseCreativeBriefDraft(JSON.stringify(brief)).product;
        expect(parsed).toEqual(expect.objectContaining({ kind: 'product', id: 'p1' }));
        expect(parsed?.kind === 'product' && parsed.attachment).toBeUndefined();
    });

    it('defaults category and usps for an already-sent message that predates those fields', () => {
        const { category: _category, usps: _usps, ...withoutNewFields } = productRecord();
        const brief = { ...createEmptyCreativeBrief(), product: withoutNewFields };
        const parsed = parseCreativeBriefDraft(JSON.stringify(brief)).product;
        expect(parsed).toEqual(expect.objectContaining({ category: null, usps: [] }));
    });

    it('drops a malformed usps value to an empty array instead of rejecting the whole product', () => {
        const brief = { ...createEmptyCreativeBrief(), product: { ...productRecord(), usps: 'not an array', category: 42 } };
        const parsed = parseCreativeBriefDraft(JSON.stringify(brief)).product;
        expect(parsed).toEqual(expect.objectContaining({ category: null, usps: [] }));
    });

    it('still restores the old product-image kind from earlier messages', () => {
        const old = { kind: 'product-image', id: 'f9', name: '_.jpeg', attachment: { fileId: 'f9', name: '_.jpeg', type: 'image/jpeg', size: 1 } };
        expect(parseCreativeBriefDraft(JSON.stringify({ product: old })).product).toEqual(old);
    });
});
