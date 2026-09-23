"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { advanceTunnelDepth, getTunnelOpacity, type TunnelPlaneLayout } from "./tunnel-model";

interface MediaPlaneProps {
    layout: TunnelPlaneLayout;
    texture: THREE.Texture | null;
    speed: number;
}

const IMAGE_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const IMAGE_FRAGMENT_SHADER = `
    uniform sampler2D uMap;
    uniform float uOpacity;
    uniform float uAspect;
    varying vec2 vUv;

    void main() {
        vec2 point = (vUv - 0.5) * vec2(uAspect, 1.0);
        vec2 halfSize = vec2(uAspect * 0.5, 0.5);
        float radius = 0.026;
        vec2 distanceToEdge = abs(point) - (halfSize - radius);
        float roundedDistance = length(max(distanceToEdge, 0.0))
            + min(max(distanceToEdge.x, distanceToEdge.y), 0.0)
            - radius;
        float roundedAlpha = 1.0 - smoothstep(-0.002, 0.004, roundedDistance);
        vec4 texel = texture2D(uMap, vUv);
        float alpha = texel.a * uOpacity * roundedAlpha;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(texel.rgb, alpha);
        #include <colorspace_fragment>
    }
`;

export function MediaPlane({ layout, texture, speed }: MediaPlaneProps) {
    const groupRef = useRef<THREE.Group>(null);
    const imageMaterialRef = useRef<THREE.ShaderMaterial>(null);
    const imageUniforms = useMemo(() => ({
        uMap: { value: texture },
        uOpacity: { value: 0 },
        uAspect: { value: layout.width / layout.height },
    }), [layout.height, layout.width, texture]);

    useFrame(({ clock }, delta) => {
        const group = groupRef.current;
        if (!group) return;

        group.position.z = advanceTunnelDepth(group.position.z, delta, speed);
        const driftTime = clock.elapsedTime * 0.14 + layout.driftPhase;
        group.position.x = layout.x + Math.sin(driftTime) * 0.012;
        group.position.y = layout.y + Math.cos(driftTime * 0.72) * 0.014;
        group.rotation.z = layout.rotationZ;

        const opacity = getTunnelOpacity(group.position.z);
        if (imageMaterialRef.current) imageMaterialRef.current.uniforms.uOpacity.value = texture ? opacity : 0;
    });

    return (
        <group
            ref={groupRef}
            position={[layout.x, layout.y, layout.z]}
            rotation={[layout.rotationX, layout.rotationY, layout.rotationZ]}
        >
            {texture && (
                <mesh>
                    <planeGeometry args={[layout.width, layout.height]} />
                    <shaderMaterial
                        ref={imageMaterialRef}
                        uniforms={imageUniforms}
                        vertexShader={IMAGE_VERTEX_SHADER}
                        fragmentShader={IMAGE_FRAGMENT_SHADER}
                        transparent
                        toneMapped={false}
                        depthWrite={false}
                    />
                </mesh>
            )}
        </group>
    );
}
