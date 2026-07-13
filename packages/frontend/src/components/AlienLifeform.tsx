import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Props {
  // Comes alive (writhes, glows, spins up) while any process is running.
  active: boolean;
  // 0..1 — more processes / more output ⇒ more agitated.
  intensity: number;
  // World-space vertical lift, so the body can sit in the upper "emitter" band
  // of a taller stage instead of dead-center. 0 = centered (default).
  offsetY?: number;
  // Camera distance — smaller ⇒ the organism fills more of the frame. Default
  // 3.3 (compact); a dedicated full-panel view pulls in closer for presence.
  camZ?: number;
}

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Ashima 3D simplex noise (public domain) — drives the organic vertex writhing.
const SIMPLEX = /* glsl */ `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i,289.0);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}`;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uSpeed;
uniform float uFreq;
varying float vDisp;
varying vec3 vN;
varying vec3 vView;
${SIMPLEX}
void main(){
  float t = uTime * uSpeed;
  float n = snoise(normal * uFreq + vec3(t));
  n += 0.5 * snoise(normal * (uFreq * 2.0) + vec3(t * 1.7 + 11.0));
  float disp = n * uAmp;
  vDisp = disp;
  vec3 pos = position + normal * disp;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vN = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uGlow;
varying float vDisp;
varying vec3 vN;
varying vec3 vView;
void main(){
  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), 2.4);
  vec3 base = mix(uCore, uColor, clamp(vDisp * 1.6 + 0.35, 0.0, 1.0));
  vec3 col = base * (0.2 + uGlow * 0.5) + uColor * fres * (0.9 + uGlow * 1.7);
  gl_FragColor = vec4(col, 1.0);
}`;

export function AlienLifeform({ active, intensity, offsetY = 0, camZ = 3.3 }: Props): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const intensityRef = useRef(intensity);
  activeRef.current = active;
  intensityRef.current = intensity;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
      return; // no WebGL — just render nothing
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, camZ);

    const accent = cssColor('--accent', '#ff2d3c');
    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.06 },
      uSpeed: { value: 0.15 },
      uFreq: { value: 1.6 },
      uGlow: { value: 0.12 },
      uColor: { value: new THREE.Color(accent) },
      uCore: { value: new THREE.Color(accent).multiplyScalar(0.12) },
    };

    // The organism: a noise-displaced icosphere with an additive fresnel glow.
    const geo = new THREE.IcosahedronGeometry(1, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = offsetY;
    scene.add(mesh);

    // Spore halo — orbiting motes that thicken as it wakes.
    const SPORES = 160;
    const pos = new Float32Array(SPORES * 3);
    for (let i = 0; i < SPORES; i++) {
      const r = 1.35 + Math.random() * 0.6;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pmat = new THREE.PointsMaterial({
      color: new THREE.Color(accent),
      size: 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(pgeo, pmat);
    points.position.y = offsetY;
    scene.add(points);

    const resize = (): void => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    const clock = new THREE.Clock();
    const cur = { amp: 0.06, speed: 0.15, glow: 0.12, rot: 0.05 };
    let colorCheck = 0;
    let raf = 0;

    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return; // don't burn GPU in the background
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const a = activeRef.current;
      const inten = Math.max(0, Math.min(1, intensityRef.current));
      const target = a
        ? { amp: 0.16 + inten * 0.24, speed: 0.5 + inten * 0.95, glow: 0.55 + inten * 0.45, rot: 0.14 + inten * 0.36 }
        : { amp: 0.06, speed: 0.15, glow: 0.12, rot: 0.05 };
      const k = 1 - Math.pow(0.02, dt); // frame-rate-independent easing toward target
      cur.amp += (target.amp - cur.amp) * k;
      cur.speed += (target.speed - cur.speed) * k;
      cur.glow += (target.glow - cur.glow) * k;
      cur.rot += (target.rot - cur.rot) * k;

      uniforms.uTime.value = t;
      uniforms.uAmp.value = cur.amp;
      uniforms.uSpeed.value = cur.speed;
      uniforms.uGlow.value = cur.glow;

      mesh.rotation.y += cur.rot * dt;
      mesh.rotation.x = Math.sin(t * 0.25) * 0.35;
      points.rotation.y -= cur.rot * 0.5 * dt;
      points.rotation.z += cur.rot * 0.2 * dt;
      pmat.opacity = 0.12 + cur.glow * 0.7;
      pmat.size = 0.04 + cur.glow * 0.03;

      // Follow live theme changes without a remount.
      if (t - colorCheck > 1) {
        colorCheck = t;
        const c = cssColor('--accent', '#ff2d3c');
        uniforms.uColor.value.set(c);
        uniforms.uCore.value.set(c).multiplyScalar(0.12);
        pmat.color.set(c);
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      geo.dispose();
      mat.dispose();
      pgeo.dispose();
      pmat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
  }, [offsetY, camZ]);

  return <div className="lp-alien" ref={mountRef} aria-hidden="true" />;
}
