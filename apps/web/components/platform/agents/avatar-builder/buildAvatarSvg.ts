import type { AvatarParams, HeadShape, EyeStyle, Accessory, MouthStyle, BackgroundTheme } from './avatarParams';

interface HeadGeometry {
    headX: number; headY: number; headW: number; headH: number; headRx: number;
    centerX: number; eyeY: number; mouthY: number; eyeSpacing: number;
}

function headGeometry(head: HeadShape): HeadGeometry {
    const byShape: Record<HeadShape, { headX: number; headY: number; headW: number; headH: number; headRx: number }> = {
        tall: { headX: 68, headY: 34, headW: 64, headH: 128, headRx: 32 },
        round: { headX: 59, headY: 48, headW: 82, headH: 98, headRx: 41 },
    };
    const { headX, headY, headW, headH, headRx } = byShape[head];
    const centerX = headX + headW / 2;
    return {
        headX, headY, headW, headH, headRx, centerX,
        eyeY: headY + headH * 0.35,
        mouthY: headY + headH * 0.74,
        eyeSpacing: headW * 0.24,
    };
}

const BG_GRADIENTS: Record<Exclude<BackgroundTheme, 'transparent'>, [string, string]> = {
    terracotta: ['#3d231e', '#1e1210'],
    light: ['#ffffff', '#e2e0d8'],
    space: ['#1e2235', '#0a0b12'],
    matrix: ['#0a2a22', '#040e0a'],
};

function renderBackground(bgTheme: BackgroundTheme): string {
    if (bgTheme === 'transparent') return '';
    const [from, to] = BG_GRADIENTS[bgTheme];
    const gridColor = bgTheme === 'light' ? 'rgba(0,0,0,0.06)' : bgTheme === 'matrix' ? 'rgba(0,255,170,0.15)' : 'rgba(255,255,255,0.07)';
    const borderColor = bgTheme === 'light' ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.12)';
    let grid = '';
    for (let i = 20; i < 200; i += 20) {
        grid += `<line x1="0" y1="${i}" x2="200" y2="${i}" stroke="${gridColor}" stroke-width="1"/>`;
    }
    return `<defs><radialGradient id="bgGlow" cx="50%" cy="50%" r="75%"><stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/></radialGradient></defs>` +
        `<rect width="200" height="200" rx="20" fill="url(#bgGlow)"/>` +
        `<rect x="2" y="2" width="196" height="196" rx="18" fill="none" stroke="${borderColor}" stroke-width="2"/>` +
        grid;
}

function renderEyes(eyes: EyeStyle, g: HeadGeometry): string {
    const { centerX, eyeY, eyeSpacing, headW } = g;
    if (eyes === 'dots') {
        return `<circle cx="${centerX - eyeSpacing}" cy="${eyeY}" r="4" fill="#1d1311"/>` +
            `<circle cx="${centerX + eyeSpacing}" cy="${eyeY}" r="4" fill="#1d1311"/>`;
    }
    if (eyes === 'shades') {
        const sw = headW * 0.88; const sx = centerX - sw / 2; const sy = eyeY - 7;
        return `<path d="M ${sx} ${sy} L ${sx + sw} ${sy} L ${sx + sw} ${sy + 12} L ${centerX + 3} ${sy + 12} L ${centerX} ${sy + 7} L ${centerX - 3} ${sy + 12} L ${sx} ${sy + 12} Z" fill="#18181c" stroke="#000" stroke-width="2"/>`;
    }
    if (eyes === 'visor') {
        const vw = headW * 0.9; const vx = centerX - vw / 2; const vy = eyeY - 7;
        return `<rect x="${vx}" y="${vy}" width="${vw}" height="14" rx="4" fill="#ff9900" stroke="#111" stroke-width="2"/>`;
    }
    // eyepatch
    const { headX, headW: hw } = g;
    return `<line x1="${headX - 2}" y1="${eyeY - 14}" x2="${headX + hw + 2}" y2="${eyeY + 10}" stroke="#111" stroke-width="3"/>` +
        `<rect x="${centerX - eyeSpacing - 10}" y="${eyeY - 10}" width="20" height="18" rx="3" fill="#18181c" stroke="#000" stroke-width="2"/>` +
        `<circle cx="${centerX + eyeSpacing}" cy="${eyeY}" r="4" fill="#1d1311"/>`;
}

function renderAccessory(accessory: Accessory, g: HeadGeometry, hairColor: string): string {
    const { headX, headY, headW, headH, centerX } = g;
    if (accessory === 'none') return '';
    if (accessory === 'cybermohawk') {
        const hairY = headY - 22;
        let grooves = '';
        for (const side of [-1, 1]) {
            const gx = centerX + side * (headW * 0.36);
            grooves += `<line x1="${gx - 6}" y1="${headY + 12}" x2="${gx + 6}" y2="${headY + 12}" stroke="#111" stroke-width="2"/>`;
        }
        return `<path d="M ${centerX - 10} ${headY + 16} L ${centerX - 8} ${hairY} Q ${centerX} ${hairY - 10} ${centerX + 8} ${hairY} L ${centerX + 10} ${headY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>${grooves}`;
    }
    if (accessory === 'hightop') {
        const hairY = headY - 28;
        return `<path d="M ${headX - 2} ${headY + 16} L ${headX - 2} ${hairY + 6} Q ${headX - 2} ${hairY} ${headX + 8} ${hairY} L ${headX + headW - 8} ${hairY} Q ${headX + headW + 2} ${hairY} ${headX + headW + 2} ${hairY + 6} L ${headX + headW + 2} ${headY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2.5"/>`;
    }
    if (accessory === 'animespikes') {
        const hairY = headY - 30;
        return `<path d="M ${headX - 10} ${headY + 20} L ${headX - 20} ${headY - 5} L ${headX - 4} ${headY + 4} L ${centerX - 18} ${hairY} L ${centerX - 4} ${headY - 2} L ${centerX} ${hairY - 10} L ${centerX + 4} ${headY - 2} L ${centerX + 18} ${hairY} L ${headX + headW + 4} ${headY + 4} L ${headX + headW + 20} ${headY - 5} L ${headX + headW + 10} ${headY + 20} Z" fill="${hairColor}" stroke="#1d1311" stroke-width="2.5"/>`;
    }
    if (accessory === 'pompadour') {
        const hairY = headY - 24;
        return `<path d="M ${headX - 2} ${headY + 18} C ${headX - 8} ${hairY}, ${centerX - 10} ${hairY - 8}, ${centerX + 10} ${hairY - 4} C ${headX + headW + 12} ${hairY}, ${headX + headW + 6} ${headY + 10}, ${headX + headW + 2} ${headY + 18} Z" fill="${hairColor}" stroke="#111" stroke-width="2.5"/>`;
    }
    if (accessory === 'curtainbangs') {
        const eyeY = g.eyeY;
        return `<path d="M ${headX - 2} ${headY + 8} Q ${centerX - 10} ${headY - 6} ${centerX} ${headY + 2} Q ${centerX + 10} ${headY - 6} ${headX + headW + 2} ${headY + 8} Q ${headX + headW + 4} ${eyeY + 4} ${centerX + 8} ${eyeY - 2} Q ${centerX} ${headY + 10} ${centerX - 8} ${eyeY - 2} Q ${headX - 4} ${eyeY + 4} ${headX - 2} ${headY + 8} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>`;
    }
    if (accessory === 'topknot') {
        return `<path d="M ${headX} ${headY + 16} Q ${centerX} ${headY - 8} ${headX + headW} ${headY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>` +
            `<circle cx="${centerX}" cy="${headY - 12}" r="11" fill="${hairColor}" stroke="#111" stroke-width="2"/>` +
            `<line x1="${centerX - 18}" y1="${headY - 8}" x2="${centerX + 18}" y2="${headY - 16}" stroke="#ffcc00" stroke-width="3"/>`;
    }
    if (accessory === 'bikerhelmet') {
        const helmH = headH * 0.52;
        return `<path d="M ${headX - 6} ${headY + helmH} L ${headX - 6} ${headY + 10} Q ${headX - 6} ${headY - 16} ${centerX} ${headY - 16} Q ${headX + headW + 6} ${headY - 16} ${headX + headW + 6} ${headY + 10} L ${headX + headW + 6} ${headY + helmH} Z" fill="#1a1f2c" stroke="#111" stroke-width="3"/>` +
            `<rect x="${centerX - 5}" y="${headY - 16}" width="10" height="${helmH + 16}" fill="#ff3344"/>`;
    }
    if (accessory === 'bandana') {
        const bandanaY = headY + headH * 0.16;
        const bandanaH = Math.max(14, headH * 0.12);
        return `<path d="M ${headX - 3} ${bandanaY} L ${headX + headW + 3} ${bandanaY} L ${headX + headW + 3} ${bandanaY + bandanaH} L ${headX - 3} ${bandanaY + bandanaH} Z" fill="#d32f2f" stroke="#111" stroke-width="3"/>` +
            `<polygon points="${headX - 10},${bandanaY + 8} ${headX - 2},${bandanaY + 2} ${headX - 2},${bandanaY + 16}" fill="#990011"/>`;
    }
    // hood
    return `<path d="M ${headX - 6} ${headY + 10} C ${headX - 6} ${headY - 15}, ${headX + headW + 6} ${headY - 15}, ${headX + headW + 6} ${headY + 10} L ${headX + headW + 8} ${headY + headH * 0.5} L ${headX + headW - 2} ${headY + headH * 0.5} L ${headX + headW - 2} ${headY + 20} L ${headX + 2} ${headY + 20} L ${headX + 2} ${headY + headH * 0.5} L ${headX - 8} ${headY + headH * 0.5} Z" fill="#1e2230"/>`;
}

function renderFacialHair(mouth: MouthStyle, g: HeadGeometry, hairColor: string): string {
    const { headX, headW, headY, headH, centerX, mouthY } = g;
    if (mouth === 'beard') {
        const beardLeft = headX + 4; const beardRight = headX + headW - 4;
        const beardTop = headY + headH * 0.65; const beardChin = headY + headH + 4;
        return `<path d="M ${beardLeft} ${beardTop} Q ${beardLeft - 2} ${beardChin} ${centerX} ${beardChin} Q ${beardRight + 2} ${beardChin} ${beardRight} ${beardTop} Q ${beardRight - 8} ${headY + headH - 4} ${centerX} ${headY + headH - 2} Q ${beardLeft + 8} ${headY + headH - 4} ${beardLeft} ${beardTop} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>` +
            `<path d="M ${centerX - 18} ${mouthY - 5} Q ${centerX - 6} ${mouthY + 3} ${centerX} ${mouthY - 1} Q ${centerX + 6} ${mouthY + 3} ${centerX + 18} ${mouthY - 5} Q ${centerX + 10} ${mouthY - 8} ${centerX} ${mouthY - 3} Q ${centerX - 10} ${mouthY - 8} ${centerX - 18} ${mouthY - 5} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>`;
    }
    if (mouth === 'goatee') {
        return `<path d="M ${centerX - 14} ${mouthY - 4} Q ${centerX} ${mouthY - 1} ${centerX + 14} ${mouthY - 4} Q ${centerX + 8} ${mouthY - 7} ${centerX} ${mouthY - 2} Q ${centerX - 8} ${mouthY - 7} ${centerX - 14} ${mouthY - 4} Z" fill="${hairColor}"/>` +
            `<path d="M ${centerX - 6} ${mouthY + 5} L ${centerX + 6} ${mouthY + 5} L ${centerX + 8} ${mouthY + 16} Q ${centerX} ${mouthY + 20} ${centerX - 8} ${mouthY + 16} Z" fill="${hairColor}" stroke="#111" stroke-width="2"/>`;
    }
    if (mouth === 'stubble') {
        const stubbleY = headY + headH * 0.65;
        let dots = '';
        for (let xOff = -headW * 0.32; xOff <= headW * 0.32; xOff += 6) {
            for (let yOff = 0; yOff <= headY + headH - stubbleY - 6; yOff += 6) {
                const currentY = stubbleY + yOff;
                const currentX = centerX + xOff;
                if (Math.abs(currentX - centerX) < 10 && Math.abs(currentY - mouthY) < 8) continue;
                dots += `<circle cx="${currentX}" cy="${currentY}" r="1.2" fill="${hairColor}" opacity="0.7"/>`;
            }
        }
        return dots;
    }
    return ''; // smile, none — no facial hair shape, just the mouth line below
}

function renderMouthLine(mouth: MouthStyle, g: HeadGeometry): string {
    const { centerX, mouthY } = g;
    const mouthW = 18;
    const d = mouth === 'smile'
        ? `M ${centerX - mouthW / 2} ${mouthY - 1} Q ${centerX} ${mouthY + 9} ${centerX + mouthW / 2} ${mouthY - 1}`
        : `M ${centerX - mouthW / 2} ${mouthY} Q ${centerX} ${mouthY + 3} ${centerX + mouthW / 2} ${mouthY}`;
    return `<path d="${d}" fill="none" stroke="#1d1311" stroke-width="2.5" stroke-linecap="round"/>`;
}

export function buildAvatarSvg(params: AvatarParams): string {
    const g = headGeometry(params.head);
    const { headX, headY, headW, headH, headRx, centerX, eyeY } = g;

    const nose = `<rect x="${centerX - 7}" y="${eyeY + 14}" width="14" height="20" rx="7" fill="#ff6b6b"/>`;
    const head = `<rect x="${headX}" y="${headY}" width="${headW}" height="${headH}" rx="${headRx}" fill="${params.skinColor}" stroke="#1d1311" stroke-width="4"/>`;

    const parts = [
        renderBackground(params.bgTheme),
        head,
        nose,
        renderEyes(params.eyes, g),
        renderAccessory(params.accessory, g, params.hairColor),
        renderFacialHair(params.mouth, g, params.hairColor),
        renderMouthLine(params.mouth, g),
    ];

    // viewBox starts at y=-15, not 0 — animespikes' tallest tip renders at
    // headY-40 (as low as -6 for the "tall" head shape), which a 0-origin
    // viewBox clips flat since SVG crops anything outside it by default.
    return `<svg width="220" height="220" viewBox="0 -15 200 215" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}
