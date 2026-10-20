/**
 * AppSmokeBackground — Web (CSS animated dark smoke/nebula aesthetic)
 *
 * Uses WebGL2 smoke shader if supported, CSS animated orbs as fallback.
 * Applied to all main app screens (not splash / login).
 */
import React, { useEffect, useRef, useState } from "react";

// ─── WebGL2 fragment shader (smoky nebula — adapted from user's design) ────────
const FRAG = `#version 300 es
precision highp float;
out vec4 O;
uniform float time;
uniform vec2 resolution;
uniform vec3 u_color;

#define FC gl_FragCoord.xy
#define R resolution
#define T (time+660.)

float rnd(vec2 p){p=fract(p*vec2(12.9898,78.233));p+=dot(p,p+34.56);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(rnd(i),rnd(i+vec2(1,0)),u.x),mix(rnd(i+vec2(0,1)),rnd(i+1.),u.x),u.y);}
float fbm(vec2 p){float t=.0,a=1.;for(int i=0;i<5;i++){t+=a*noise(p);p*=mat2(1,-1.2,.2,1.2)*2.;a*=.5;}return t;}

void main(){
  vec2 uv=(FC-.5*R)/R.y;
  vec3 col=vec3(1);
  uv.x+=.25;
  uv*=vec2(2,1);
  float n=fbm(uv*.28-vec2(T*.01,0));
  n=noise(uv*3.+n*2.);
  col.r-=fbm(uv+vec2(0,T*.015)+n);
  col.g-=fbm(uv*1.003+vec2(0,T*.015)+n+.003);
  col.b-=fbm(uv*1.006+vec2(0,T*.015)+n+.006);
  col=mix(col, u_color, dot(col,vec3(.21,.71,.07)));
  col=mix(vec3(.04),col,min(time*.12,1.));
  col=clamp(col,.04,1.);
  O=vec4(col,1);
}`;

const VERT = `#version 300 es
precision highp float;
in vec4 position;
void main(){gl_Position=position;}`;

function canUseWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

function hexToVec(hex: string): [number, number, number] {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r
    ? [parseInt(r[1], 16) / 255, parseInt(r[2], 16) / 255, parseInt(r[3], 16) / 255]
    : [0.08, 0.12, 0.32];
}

// ─── WebGL2 smoke renderer hook ────────────────────────────────────────────────
function useWebGLSmoke(canvas: HTMLCanvasElement | null, smokeColor: string) {
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!canvas) return;
    const gl = canvas.getContext("webgl2");
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const uRes  = gl.getUniformLocation(prog, "resolution");
    const uTime = gl.getUniformLocation(prog, "time");
    const uCol  = gl.getUniformLocation(prog, "u_color");

    const resize = () => {
      const dpr = Math.max(1, devicePixelRatio);
      canvas.width  = innerWidth  * dpr;
      canvas.height = innerHeight * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener("resize", resize);

    const loop = (now: number) => {
      gl.clearColor(0.02, 0.03, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, now * 1e-3);
      gl.uniform3fv(uCol, hexToVec(smokeColor));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      gl.deleteProgram(prog);
    };
  }, [canvas, smokeColor]);
}

// ─── CSS animated smoke (fallback) ────────────────────────────────────────────
// ─── Global mobile-web fixes (injected once) ───────────────────────────────────
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

const CSS_ID = "safegpt-app-smoke-css";

function injectCSS() {
  injectGlobalMobileCSS();
  if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
    @keyframes sgA1{0%,100%{transform:translate(0%,0%) scale(1)}33%{transform:translate(6%,-8%) scale(1.08)}66%{transform:translate(-5%,5%) scale(0.95)}}
    @keyframes sgA2{0%,100%{transform:translate(0%,0%) scale(1)}40%{transform:translate(-7%,6%) scale(1.1)}80%{transform:translate(8%,-4%) scale(0.93)}}
    @keyframes sgA3{0%,100%{transform:translate(0%,0%) scale(1)}50%{transform:translate(5%,8%) scale(1.06)}}
    @keyframes sgA4{0%,100%{transform:translate(0%,0%) scale(1)}30%{transform:translate(-9%,-5%) scale(1.12)}70%{transform:translate(4%,7%) scale(0.9)}}
    .sg-app-root{position:absolute;inset:0;overflow:hidden;background:#060912}
    .sg-app-orb{position:absolute;border-radius:50%;filter:blur(100px);mix-blend-mode:screen}
    .sg-app-o1{width:75%;height:75%;top:-20%;left:-15%;background:radial-gradient(circle,#0d1b50 0%,transparent 70%);animation:sgA1 40s ease-in-out infinite;opacity:0.6}
    .sg-app-o2{width:65%;height:65%;bottom:-15%;right:-10%;background:radial-gradient(circle,#1a0d40 0%,transparent 70%);animation:sgA2 48s ease-in-out infinite;opacity:0.5}
    .sg-app-o3{width:50%;height:50%;top:30%;left:25%;background:radial-gradient(circle,#071535 0%,transparent 70%);animation:sgA3 56s ease-in-out infinite;opacity:0.4}
    .sg-app-o4{width:60%;height:60%;top:10%;right:5%;background:radial-gradient(circle,#0a0f38 0%,transparent 70%);animation:sgA4 64s ease-in-out infinite;opacity:0.35}
    .sg-app-content{position:absolute;inset:0;display:flex}
  `;
  document.head.appendChild(style);
}

function CSSSmoke({
  children,
  contentStyle,
}: {
  children?: React.ReactNode;
  contentStyle?: React.CSSProperties;
}) {
  useEffect(() => { injectCSS(); }, []);
  return (
    <div className="sg-app-root">
      <div className="sg-app-orb sg-app-o1" />
      <div className="sg-app-orb sg-app-o2" />
      <div className="sg-app-orb sg-app-o3" />
      <div className="sg-app-orb sg-app-o4" />
      <div className="sg-app-content" style={contentStyle}>
        {children}
      </div>
    </div>
  );
}

function WebGLSmoke({
  smokeColor,
  children,
  contentStyle,
}: {
  smokeColor: string;
  children?: React.ReactNode;
  contentStyle?: React.CSSProperties;
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useWebGLSmoke(canvas, smokeColor);

  return (
    <div style={{ position: "absolute", inset: 0, background: "#060912" }}>
      <canvas
        ref={setCanvas}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      <div style={{ position: "absolute", inset: 0, display: "flex", ...contentStyle }}>
        {children}
      </div>
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────
interface AppSmokeBackgroundProps {
  smokeColor?: string;
  children?: React.ReactNode;
  /** Pass flex/layout styles here — applied to the content container */
  style?: React.CSSProperties & { flexDirection?: "row" | "column"; flex?: number };
}

export function AppSmokeBackground({
  smokeColor = "#101c52",
  children,
  style,
}: AppSmokeBackgroundProps) {
  const [gl2, setGl2] = useState(false);
  useEffect(() => { setGl2(canUseWebGL2()); }, []);

  const contentStyle: React.CSSProperties = {
    flexDirection: (style?.flexDirection as any) ?? "column",
    flex: style?.flex ?? 1,
  };

  if (gl2) {
    return (
      <WebGLSmoke smokeColor={smokeColor} contentStyle={contentStyle}>
        {children}
      </WebGLSmoke>
    );
  }
  return <CSSSmoke contentStyle={contentStyle}>{children}</CSSSmoke>;
}
