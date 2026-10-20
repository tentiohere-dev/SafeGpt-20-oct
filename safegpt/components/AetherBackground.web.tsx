import React, { useRef, useEffect, useState } from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import * as THREE from "three";

interface AetherBackgroundProps {
  children?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  hue?: number;
  speed?: number;
  intensity?: number;
  complexity?: number;
  warp?: number;
}

const VERTEX_SHADER = `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;
  uniform vec2 u_resolution;
  uniform float u_time;
  uniform vec2 u_mouse;
  uniform float u_hue;
  uniform float u_speed;
  uniform float u_intensity;
  uniform float u_complexity;
  uniform float u_warp;

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
  }

  float noise(vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(random(i), random(i + vec2(1.0, 0.0)), u.x),
               mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 st) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 10; i++) {
      if (i >= int(u_complexity)) break;
      value += amplitude * noise(st);
      st *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  mat2 rotate(float angle) {
    return mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
    float t = u_time * u_speed;

    vec2 mouse_uv = (u_mouse * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
    float warp_effect = smoothstep(0.7, 0.0, distance(uv, mouse_uv)) * u_warp;

    vec2 p = uv * rotate(t * 0.1) + warp_effect;

    float n1 = fbm(p * 1.2 + vec2(t * 0.1, t * 0.2));
    float n2 = fbm(p * 2.0 + n1 + vec2(-t * 0.25, t * 0.15));
    float n3 = fbm(p * 3.5 + n2 + vec2(t * 0.1, -t * 0.2));

    float final_noise = n1 * 0.6 + n2 * 0.25 + n3 * 0.15;

    float hue_shift = final_noise * 0.1;
    float saturation = 0.6 + final_noise * 0.4;
    float value = 0.15 + pow(final_noise, 2.5) * u_intensity;
    value += pow(smoothstep(0.7, 1.0, final_noise), 3.0) * 0.7 * u_intensity;

    vec3 color = hsv2rgb(vec3((u_hue / 360.0) + hue_shift, saturation, value));
    color *= 1.0 - smoothstep(0.8, 1.5, length(uv));

    gl_FragColor = vec4(color, 1.0);
  }
`;

function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const ctx =
      canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    return !!ctx;
  } catch {
    return false;
  }
}

const GLOBAL_CSS_ID = "safegpt-global-mobile";
function injectGlobalMobileCSS() {
  if (typeof document === "undefined" || document.getElementById(GLOBAL_CSS_ID)) return;
  const s = document.createElement("style");
  s.id = GLOBAL_CSS_ID;
  s.textContent = `
    html, body {
      overflow-x: hidden;
      max-width: 100%;
      overscroll-behavior: none;
    }
    body {
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    * { box-sizing: border-box; }
  `;
  document.head.appendChild(s);
}

const CSS_ANIM_ID = "aether-css-keyframes";

function injectCSSAnimations() {
  injectGlobalMobileCSS();
  if (document.getElementById(CSS_ANIM_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ANIM_ID;
  style.textContent = `
    @keyframes aether-flow {
      0%   { background-position: 0% 0%;   }
      25%  { background-position: 100% 0%; }
      50%  { background-position: 100% 100%; }
      75%  { background-position: 0% 100%; }
      100% { background-position: 0% 0%;   }
    }
    @keyframes aether-pulse {
      0%, 100% { opacity: 0.6; transform: scale(1);   }
      50%       { opacity: 0.9; transform: scale(1.06); }
    }
    @keyframes aether-orb1 {
      0%   { transform: translate(0px, 0px) scale(1);    }
      33%  { transform: translate(60px, -40px) scale(1.1); }
      66%  { transform: translate(-30px, 50px) scale(0.95); }
      100% { transform: translate(0px, 0px) scale(1);    }
    }
    @keyframes aether-orb2 {
      0%   { transform: translate(0px, 0px) scale(1);     }
      33%  { transform: translate(-50px, 30px) scale(1.05); }
      66%  { transform: translate(40px, -60px) scale(1.1);  }
      100% { transform: translate(0px, 0px) scale(1);     }
    }
    @keyframes aether-orb3 {
      0%   { transform: translate(0px, 0px) scale(1);     }
      50%  { transform: translate(30px, 40px) scale(1.08);  }
      100% { transform: translate(0px, 0px) scale(1);     }
    }
  `;
  document.head.appendChild(style);
}

function CSSFallbackCanvas() {
  const ref = useRef<any>(null);

  useEffect(() => {
    injectCSSAnimations();
    const el: HTMLElement | null = ref.current;
    if (!el) return;

    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.overflow = "hidden";
    el.style.background = "linear-gradient(135deg, #050c1a 0%, #0a1628 30%, #0d1f3c 60%, #060d1a 100%)";

    const base = document.createElement("div");
    base.style.cssText = `
      position:absolute; inset:0;
      background: linear-gradient(120deg,
        #0a0f2e 0%,
        #0d1b4a 20%,
        #112060 40%,
        #0a1235 60%,
        #050820 80%,
        #0a0f2e 100%
      );
      background-size: 300% 300%;
      animation: aether-flow 18s ease-in-out infinite;
    `;
    el.appendChild(base);

    const orb1 = document.createElement("div");
    orb1.style.cssText = `
      position:absolute;
      width:55%; height:55%;
      top:-10%; left:-10%;
      background: radial-gradient(ellipse at center,
        rgba(59,90,220,0.55) 0%,
        rgba(30,50,140,0.3) 40%,
        transparent 70%
      );
      border-radius:50%;
      filter: blur(40px);
      animation: aether-orb1 14s ease-in-out infinite;
    `;
    el.appendChild(orb1);

    const orb2 = document.createElement("div");
    orb2.style.cssText = `
      position:absolute;
      width:60%; height:60%;
      bottom:-15%; right:-15%;
      background: radial-gradient(ellipse at center,
        rgba(100,60,200,0.5) 0%,
        rgba(60,30,130,0.28) 40%,
        transparent 70%
      );
      border-radius:50%;
      filter: blur(45px);
      animation: aether-orb2 17s ease-in-out infinite;
    `;
    el.appendChild(orb2);

    const orb3 = document.createElement("div");
    orb3.style.cssText = `
      position:absolute;
      width:40%; height:40%;
      top:30%; left:30%;
      background: radial-gradient(ellipse at center,
        rgba(20,80,180,0.45) 0%,
        rgba(10,40,100,0.2) 50%,
        transparent 75%
      );
      border-radius:50%;
      filter: blur(35px);
      animation: aether-orb3 20s ease-in-out infinite;
    `;
    el.appendChild(orb3);

    const sparkle = document.createElement("div");
    sparkle.style.cssText = `
      position:absolute; inset:0;
      background:
        radial-gradient(1px 1px at 20% 30%, rgba(160,180,255,0.6) 0%, transparent 100%),
        radial-gradient(1px 1px at 80% 20%, rgba(160,180,255,0.5) 0%, transparent 100%),
        radial-gradient(1px 1px at 50% 70%, rgba(180,160,255,0.4) 0%, transparent 100%),
        radial-gradient(1px 1px at 75% 60%, rgba(140,180,255,0.5) 0%, transparent 100%),
        radial-gradient(1px 1px at 10% 80%, rgba(160,200,255,0.4) 0%, transparent 100%),
        radial-gradient(1px 1px at 90% 75%, rgba(180,160,255,0.35) 0%, transparent 100%),
        radial-gradient(1px 1px at 35% 50%, rgba(200,180,255,0.45) 0%, transparent 100%);
      animation: aether-pulse 8s ease-in-out infinite;
    `;
    el.appendChild(sparkle);

    const vignette = document.createElement("div");
    vignette.style.cssText = `
      position:absolute; inset:0;
      background: radial-gradient(ellipse at 50% 50%,
        transparent 40%,
        rgba(2,5,15,0.7) 100%
      );
    `;
    el.appendChild(vignette);

    return () => {
      while (el.firstChild) el.removeChild(el.firstChild);
    };
  }, []);

  return <View ref={ref} style={StyleSheet.absoluteFillObject} />;
}

function WebGLCanvas({ hue, speed, intensity, complexity, warp }: {
  hue: number; speed: number; intensity: number; complexity: number; warp: number;
}) {
  const shaderRef = useRef<any>(null);
  const propsRef = useRef({ hue, speed, intensity, complexity, warp });

  useEffect(() => {
    propsRef.current = { hue, speed, intensity, complexity, warp };
  }, [hue, speed, intensity, complexity, warp]);

  useEffect(() => {
    const mount: HTMLElement | null = shaderRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);

    const canvas = renderer.domElement;
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    mount.appendChild(canvas);

    const uniforms = {
      u_time: { value: 0.0 },
      u_resolution: { value: new THREE.Vector2(mount.clientWidth * window.devicePixelRatio, mount.clientHeight * window.devicePixelRatio) },
      u_mouse: { value: new THREE.Vector2(mount.clientWidth * 0.5, mount.clientHeight * 0.5) },
      u_hue: { value: propsRef.current.hue },
      u_speed: { value: propsRef.current.speed },
      u_intensity: { value: propsRef.current.intensity },
      u_complexity: { value: propsRef.current.complexity },
      u_warp: { value: propsRef.current.warp },
    };

    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER });
    scene.add(new THREE.Mesh(geometry, material));

    const clock = new THREE.Clock();
    let raf: number;

    const animate = () => {
      uniforms.u_time.value = clock.getElapsedTime();
      uniforms.u_hue.value = propsRef.current.hue;
      uniforms.u_speed.value = propsRef.current.speed;
      uniforms.u_intensity.value = propsRef.current.intensity;
      uniforms.u_complexity.value = propsRef.current.complexity;
      uniforms.u_warp.value = propsRef.current.warp;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      if (!mount) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      uniforms.u_resolution.value.set(w * window.devicePixelRatio, h * window.devicePixelRatio);
    };
    window.addEventListener("resize", handleResize);

    const handleMouseMove = (e: MouseEvent) => {
      uniforms.u_mouse.value.x = e.clientX;
      uniforms.u_mouse.value.y = window.innerHeight - e.clientY;
    };
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
      if (mount.contains(canvas)) mount.removeChild(canvas);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  return <View ref={shaderRef} style={StyleSheet.absoluteFillObject} />;
}

export function AetherBackground({
  children,
  style,
  hue = 220,
  speed = 0.12,
  intensity = 0.75,
  complexity = 6,
  warp = 0.3,
}: AetherBackgroundProps) {
  const [webglAvailable] = useState(() => canUseWebGL());

  return (
    <View style={[styles.container, style as ViewStyle]}>
      {webglAvailable ? (
        <WebGLCanvas hue={hue} speed={speed} intensity={intensity} complexity={complexity} warp={warp} />
      ) : (
        <CSSFallbackCanvas />
      )}
      <View style={[StyleSheet.absoluteFillObject, styles.overlay]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, position: "relative" },
  overlay: { backgroundColor: "rgba(0,0,0,0.12)" },
});
