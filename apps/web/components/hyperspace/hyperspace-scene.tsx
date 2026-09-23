"use client";

import { useEffect, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
    HYPERSPACE_MEDIA,
    type HyperspaceMediaItem,
    type HyperspaceQuality,
} from "./media-manifest";
import { MediaPlane } from "./media-plane";
import type { HyperspaceQualityTier } from "./quality-tier";
import { createTunnelLayout } from "./tunnel-model";
import { listenForWebGLContextLoss } from "./webgl-context";

interface HyperspaceSceneProps {
    tier: HyperspaceQualityTier;
    arriving: boolean;
    visualTheme: "light" | "dark";
    onContextLost: () => void;
}

function ContextLossGuard({ onContextLost }: Pick<HyperspaceSceneProps, "onContextLost">) {
    const { gl } = useThree();

    useEffect(
        () => listenForWebGLContextLoss(gl.domElement, onContextLost),
        [gl, onContextLost],
    );

    return null;
}

function useSharedStagedTextures(
    quality: HyperspaceQuality,
    mediaItems: readonly HyperspaceMediaItem[],
) {
    const { gl } = useThree();
    const [textures, setTextures] = useState<ReadonlyMap<string, THREE.Texture>>(() => new Map());

    useEffect(() => {
        let disposed = false;
        const loadedTextures: THREE.Texture[] = [];
        mediaItems.forEach((item) => {
            new THREE.TextureLoader().load(
                item.sources[quality].src,
                (texture) => {
                    if (disposed) {
                        texture.dispose();
                        return;
                    }
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy());
                    texture.needsUpdate = true;
                    loadedTextures.push(texture);
                    setTextures((current) => {
                        const next = new Map(current);
                        next.set(item.id, texture);
                        return next;
                    });
                },
                undefined,
                (error) => {
                    console.warn(`hyperspace: failed to load ${item.sources[quality].src}`, error);
                },
            );
        });

        return () => {
            disposed = true;
            loadedTextures.forEach((texture) => texture.dispose());
        };
    }, [gl, mediaItems, quality]);

    return textures;
}

const FLOOR_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FLOOR_FRAGMENT_SHADER = `
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
        float edgeX = smoothstep(0.0, 0.18, vUv.x) * smoothstep(0.0, 0.18, 1.0 - vUv.x);
        float edgeY = smoothstep(0.0, 0.16, vUv.y) * smoothstep(0.0, 0.3, 1.0 - vUv.y);
        float centerSheen = 1.0 - abs(vUv.x - 0.5) * 2.0;
        float alpha = edgeX * edgeY * (0.025 + centerSheen * 0.12);
        gl_FragColor = vec4(uColor, alpha);
    }
`;

function FloorSheen({ visualTheme }: Pick<HyperspaceSceneProps, "visualTheme">) {
    const uniforms = useMemo(
        () => ({ uColor: { value: new THREE.Color(visualTheme === "dark" ? "#8b5949" : "#bfa79b") } }),
        [visualTheme],
    );

    return (
        <mesh position={[0, -5.6, -45]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[30, 96]} />
            <shaderMaterial
                uniforms={uniforms}
                vertexShader={FLOOR_VERTEX_SHADER}
                fragmentShader={FLOOR_FRAGMENT_SHADER}
                transparent
                depthWrite={false}
            />
        </mesh>
    );
}

function CorridorEnvironment({ visualTheme }: Pick<HyperspaceSceneProps, "visualTheme">) {
    const isDark = visualTheme === "dark";
    return (
        <>
            <ambientLight intensity={isDark ? 0.34 : 1.15} color={isDark ? "#7d5143" : "#fff7f0"} />
            <pointLight position={[0, 1.5, -18]} intensity={isDark ? 8 : 22} distance={42} color="#f2a080" />
            <pointLight position={[0, -2, -55]} intensity={isDark ? 4 : 16} distance={48} color={isDark ? "#a66b55" : "#fff3e7"} />
            <FloorSheen visualTheme={visualTheme} />
        </>
    );
}

function Tunnel({
    tier,
    arriving,
    visualTheme,
}: Omit<HyperspaceSceneProps, "onContextLost">) {
    const layouts = useMemo(
        () => createTunnelLayout(HYPERSPACE_MEDIA, tier.planeCount),
        [tier.planeCount],
    );
    const visibleMedia = useMemo(() => {
        const mediaIndices = new Set(layouts.map((layout) => layout.mediaIndex));
        return [...mediaIndices].map((index) => HYPERSPACE_MEDIA[index]);
    }, [layouts]);
    const textures = useSharedStagedTextures(tier.name, visibleMedia);

    useFrame(({ camera, clock }) => {
        const time = clock.elapsedTime;
        camera.position.x = Math.sin(time * 0.13) * 0.08;
        camera.position.y = Math.cos(time * 0.11) * 0.05;
        camera.rotation.z = Math.sin(time * 0.09) * 0.0015;
    });

    const speed = arriving ? 2.4 : 7.35;

    return (
        <>
            <CorridorEnvironment visualTheme={visualTheme} />
            {layouts.map((layout, index) => {
                const item = HYPERSPACE_MEDIA[layout.mediaIndex];
                return (
                    <MediaPlane
                        key={`${layout.segment}-${layout.side}-${layout.row}-${index}`}
                        layout={layout}
                        texture={textures.get(item.id) ?? null}
                        speed={speed}
                    />
                );
            })}
        </>
    );
}

export default function HyperspaceScene({ tier, arriving, visualTheme, onContextLost }: HyperspaceSceneProps) {
    return (
        <Canvas
            className="h-full w-full"
            camera={{ fov: 48, near: 0.1, far: 110, position: [0, 0, 0] }}
            dpr={tier.dpr}
            gl={{
                alpha: true,
                antialias: tier.name !== "low",
                powerPreference: "high-performance",
            }}
            onCreated={({ gl, scene }) => {
                gl.outputColorSpace = THREE.SRGBColorSpace;
                gl.toneMapping = THREE.ACESFilmicToneMapping;
                gl.toneMappingExposure = 1.02;
                gl.setClearColor(visualTheme === "dark" ? "#0d0908" : "#f6efe8", 0);
                scene.fog = new THREE.Fog(visualTheme === "dark" ? "#130d0b" : "#eadfd7", 44, 88);
            }}
        >
            <ContextLossGuard onContextLost={onContextLost} />
            <Tunnel tier={tier} arriving={arriving} visualTheme={visualTheme} />
        </Canvas>
    );
}
