import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  CircleGeometry,
  TorusGeometry,
  Vector3
} from '@iwsdk/core';

import { PAINT } from '../constants.js';
import { addOutline, LIGHT_GLSL, mulberry32, NOISE_GLSL, toon } from './fx.js';
import { createStripeMaterial } from './tower.js';

export interface FairgroundHandles {
  group: Group;
  /** The big wheel — spun by the environment system. */
  wheel: Group;
  /** Gulls wheeling around the tower; positions are recomputed each frame. */
  gulls: InstancedMesh;
  gullSeeds: number[];
}

/**
 * The fair at the foot of the tower: striped tents, a big wheel, bunting
 * strung between poles, and umbrellas down on the beach. All deterministic.
 */
export function createFairground(heightAt: (x: number, z: number) => number): FairgroundHandles {
  const group = new Group();
  const rnd = mulberry32(77);

  // --- Plaza paving ------------------------------------------------------------
  const plaza = new Mesh(new CircleGeometry(112, 96), createPavingMaterial());
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.06;
  group.add(plaza);

  // --- Tents ----------------------------------------------------------------
  const tentSpots: Array<[number, number, number, number]> = [
    // x, z, radius, colour
    [58, -46, 7, PAINT.red],
    [-64, -38, 6, PAINT.sea],
    [-52, 62, 6.5, PAINT.gold],
    [66, 40, 5.5, PAINT.mint],
    [4, -78, 8, PAINT.red],
    [-88, 6, 5, PAINT.sea]
  ];
  tentSpots.forEach(([x, z, r, color]) => {
    const tent = new Group();
    const wall = new Mesh(
      new CylinderGeometry(r, r, r * 0.55, 24, 1, true),
      createStripeMaterial({ colorA: color, colorB: PAINT.cream, stripes: 12, wear: 0.04 })
    );
    wall.position.y = r * 0.275;
    const roof = new Mesh(
      new ConeGeometry(r * 1.1, r * 0.7, 24, 1),
      createStripeMaterial({ colorA: PAINT.cream, colorB: color, stripes: 12, wear: 0.04 })
    );
    roof.position.y = r * 0.55 + r * 0.35;
    const pole = new Mesh(new CylinderGeometry(0.08, 0.08, r * 0.6, 6), toon({ color: 0xf6f1e6 }));
    pole.position.y = r * 0.9 + r * 0.3;
    const pennant = new Mesh(new PlaneGeometry(1.2, 0.6), toon({ color, side: DoubleSide }));
    pennant.position.set(0.6, r * 0.9 + r * 0.55, 0);
    addOutline(wall, 0.1);
    addOutline(roof, 0.1);
    tent.add(wall, roof, pole, pennant);
    tent.position.set(x, 0, z);
    tent.rotation.y = rnd() * Math.PI;
    group.add(tent);
  });

  // --- Big wheel -------------------------------------------------------------
  const wheel = new Group();
  const wheelRadius = 24;
  const wheelRoot = new Group();
  wheelRoot.position.set(-118, wheelRadius + 6, 92);
  wheelRoot.rotation.y = 0.9;
  const steel = toon({ color: 0xf3efe6 });
  const rim = new Mesh(new TorusGeometry(wheelRadius, 0.45, 10, 72), steel);
  const rimInner = new Mesh(new TorusGeometry(wheelRadius - 3, 0.3, 8, 72), steel);
  addOutline(rim, 0.14);
  wheel.add(rim, rimInner);
  const spokeGeo = new BoxGeometry(0.28, wheelRadius * 2, 0.28);
  const gondolaGeo = new BoxGeometry(2.6, 2.2, 2.2);
  const gondolaColors = [PAINT.red, PAINT.gold, PAINT.sea, PAINT.mint];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI;
    const spoke = new Mesh(spokeGeo, steel);
    spoke.rotation.z = a;
    wheel.add(spoke);
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const gondola = new Mesh(
      gondolaGeo,
      toon({ color: gondolaColors[i % gondolaColors.length] })
    );
    gondola.position.set(Math.cos(a) * wheelRadius, Math.sin(a) * wheelRadius, 0);
    wheel.add(gondola);
  }
  wheelRoot.add(wheel);
  // Hub and A-frame legs.
  const hub = new Mesh(new CylinderGeometry(1.2, 1.2, 3.2, 16), toon({ color: PAINT.red }));
  hub.rotation.x = Math.PI / 2;
  wheelRoot.add(hub);
  const legGeo = new BoxGeometry(0.9, wheelRadius + 8, 0.9);
  [-1, 1].forEach((side) => {
    [-1, 1].forEach((front) => {
      const leg = new Mesh(legGeo, toon({ color: PAINT.red }));
      leg.position.set(side * 7, -(wheelRadius + 6) / 2 + 0.5, front * 2.6);
      leg.rotation.z = -side * 0.27;
      leg.rotation.x = front * 0.1;
      wheelRoot.add(leg);
    });
  });
  group.add(wheelRoot);

  // --- Bunting around the plaza ---------------------------------------------
  const poleCount = 14;
  const poleRadius = 44;
  const poleMat = toon({ color: 0xf6f1e6 });
  const poleGeo = new CylinderGeometry(0.09, 0.11, 6, 8);
  const flagColors = [PAINT.red, PAINT.gold, PAINT.sea, PAINT.cream, PAINT.mint];
  const flags = new InstancedMesh(new PlaneGeometry(0.5, 0.65), toon({ side: DoubleSide }), poleCount * 12);
  const linePts: number[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);
  const p = new Vector3();
  const color = new Color();
  let f = 0;
  for (let i = 0; i < poleCount; i++) {
    const a0 = (i / poleCount) * Math.PI * 2;
    const a1 = ((i + 1) / poleCount) * Math.PI * 2;
    const pole = new Mesh(poleGeo, poleMat);
    pole.position.set(Math.cos(a0) * poleRadius, 3, Math.sin(a0) * poleRadius);
    group.add(pole);
    const finialBall = new Mesh(new SphereGeometry(0.22, 10, 8), toon({ color: PAINT.gold }));
    finialBall.position.set(pole.position.x, 6.1, pole.position.z);
    group.add(finialBall);
    // A sagging string of flags to the next pole.
    const x0 = Math.cos(a0) * poleRadius;
    const z0 = Math.sin(a0) * poleRadius;
    const x1 = Math.cos(a1) * poleRadius;
    const z1 = Math.sin(a1) * poleRadius;
    const steps = 12;
    let px = x0;
    let py = 5.9;
    let pz = z0;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const sag = Math.sin(t * Math.PI) * 1.4;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = 5.9 - sag;
      linePts.push(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
      if (k < steps) {
        p.set(x, y - 0.4, z);
        q.setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2);
        m.compose(p, q, one);
        flags.setMatrixAt(f, m);
        color.setHex(flagColors[(i + k) % flagColors.length]);
        flags.setColorAt(f, color);
        f++;
      }
    }
  }
  flags.count = f;
  group.add(flags);
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute('position', new Float32BufferAttribute(linePts, 3));
  group.add(new LineSegments(lineGeo, new LineBasicMaterial({ color: 0x3a3330 })));

  // --- Beach umbrellas and a ticket booth ------------------------------------
  const umbrellaCount = 18;
  const canopies = new InstancedMesh(new ConeGeometry(1.6, 0.7, 10), toon({ side: DoubleSide }), umbrellaCount);
  const stems = new InstancedMesh(new CylinderGeometry(0.04, 0.04, 2.2, 5), poleMat, umbrellaCount);
  for (let i = 0; i < umbrellaCount; i++) {
    const x = (rnd() - 0.5) * 520;
    const z = 250 + rnd() * 60;
    const y = heightAt(x, z);
    if (y < 0.2) continue;
    p.set(x, y + 2.3, z);
    m.compose(p, q.identity(), one);
    canopies.setMatrixAt(i, m);
    color.setHex(flagColors[i % flagColors.length]);
    canopies.setColorAt(i, color);
    p.set(x, y + 1.1, z);
    m.compose(p, q, one);
    stems.setMatrixAt(i, m);
  }
  addOutline(canopies, 0.05);
  group.add(canopies, stems);

  const booth = new Group();
  const boothBody = new Mesh(new BoxGeometry(4, 3, 3), toon({ color: PAINT.cream }));
  boothBody.position.y = 1.5;
  addOutline(boothBody, 0.07);
  const boothRoof = new Mesh(
    new ConeGeometry(3.4, 1.6, 4, 1),
    createStripeMaterial({ colorA: PAINT.red, colorB: PAINT.cream, stripes: 8, wear: 0.03 })
  );
  boothRoof.position.y = 3.8;
  boothRoof.rotation.y = Math.PI / 4;
  booth.add(boothBody, boothRoof);
  booth.position.set(34, 0, 30);
  booth.rotation.y = -0.7;
  group.add(booth);

  // --- Gulls -------------------------------------------------------------------
  const gullCount = 14;
  const gulls = new InstancedMesh(
    new PlaneGeometry(1.4, 0.5),
    toon({ color: 0xffffff, side: DoubleSide }),
    gullCount
  );
  gulls.frustumCulled = false;
  const gullSeeds: number[] = [];
  for (let i = 0; i < gullCount; i++) gullSeeds.push(rnd() * 1000);
  group.add(gulls);

  return { group, wheel, gulls, gullSeeds };
}

/** Warm sandstone flagstones with mortar lines and a little grime. */
function createPavingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {}]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      ${LIGHT_GLSL}
      void main() {
        vec2 p = vWorld.xz;
        // Concentric rings of flagstones around the tower.
        float r = length(p);
        float a = atan(p.y, p.x);
        float ring = floor(r / 2.2);
        float around = a * (ring + 4.0) * 0.9;
        vec2 cell = vec2(fract(r / 2.2), fract(around));
        float mortar = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
        float line = 1.0 - smoothstep(0.0, 0.06, mortar);
        float tone = hash13(vec3(ring, floor(around), 1.0));
        vec3 stone = mix(vec3(0.40, 0.34, 0.27), vec3(0.50, 0.44, 0.35), step(0.5, tone));
        stone *= 1.0 + (fbm(vWorld * 0.4) - 0.5) * 0.25;
        vec3 albedo = mix(stone, vec3(0.2, 0.18, 0.16), line * 0.8);
        // A red ring marks the slide's exit run-out.
        float exitRing = 1.0 - smoothstep(0.35, 0.6, abs(r - 24.5));
        albedo = mix(albedo, vec3(0.7, 0.1, 0.08), exitRing * 0.85);
        gl_FragColor = vec4(shade(albedo, vec3(0.0, 1.0, 0.0)), 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
}
