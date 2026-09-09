import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3
} from '@iwsdk/core';

import {
  BAY_RUN,
  PAINT,
  ROOF_HEIGHT,
  SLIDE_RADIUS,
  TIER_HEIGHTS,
  TOWER_RADIUS,
  TOWER_TOP,
  TRACK_WIDTH
} from '../constants.js';
import { helterPath } from '../ride/path.js';
import { addOutline, LIGHT_GLSL, makeGlow, NOISE_TEX_GLSL, noiseUniform, toon } from './fx.js';

export interface TowerHandles {
  group: Group;
  uniforms: { uTime: { value: number } };
}

/**
 * Painted stripes, lit by the shared sun and fogged like everything else.
 * `twist` tilts the stripes into a spiral (radians of climb per metre) —
 * the tower's stripes wind the same way the slide does.
 */
export function createStripeMaterial(opts: {
  colorA: number;
  colorB: number;
  stripes: number;
  twist?: number;
  wear?: number;
}): ShaderMaterial {
  const uniforms = UniformsUtils.merge([
    UniformsLib.fog,
    {
      uColorA: { value: new Color(opts.colorA) },
      uColorB: { value: new Color(opts.colorB) },
      uStripes: { value: opts.stripes },
      uTwist: { value: opts.twist ?? 0 },
      uWear: { value: opts.wear ?? 0.08 }
    }
  ]);
  uniforms.uNoise = noiseUniform();
  return new ShaderMaterial({
    fog: true,
    side: DoubleSide,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      #include <fog_pars_vertex>
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uStripes;
      uniform float uTwist;
      uniform float uWear;
      #include <fog_pars_fragment>
      ${NOISE_TEX_GLSL}
      ${LIGHT_GLSL}
      void main() {
        float angle = atan(vLocal.z, vLocal.x) / 6.2831853;
        float band = fract(angle * uStripes + vLocal.y * uTwist);
        // Anti-aliased edge between the two paints.
        float w = fwidth(band) * 1.5;
        float mixv = smoothstep(0.5 - w, 0.5 + w, band) * (1.0 - smoothstep(1.0 - w, 1.0, band));
        vec3 albedo = mix(uColorA, uColorB, mixv);
        // Weathering: sun-bleached patches and grime streaks (one lookup,
        // wrapped around the drum by a skewed projection).
        float wear = fbmTex(vec2(vWorld.x * 0.7 + vWorld.z * 0.4, vWorld.y * 0.9) * 0.35) - 0.5;
        albedo *= 1.0 + wear * uWear * 2.0;
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 col = shade(albedo, n);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
}

/** A flat annulus sector in the XZ plane (normals up) between two angles. */
export function annulusSector(
  rIn: number,
  rOut: number,
  a0: number,
  a1: number,
  segments = 48
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    const c = Math.cos(a);
    const s = Math.sin(a);
    positions.push(c * rIn, 0, s * rIn, c * rOut, 0, s * rOut);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, i / segments, 1, i / segments);
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The tower itself: a 300m candy-striped drum with a pointed red roof, a
 * gold finial and a flag, a balcony where you start, and a plinth at its
 * foot. Its stripes spiral with the slide.
 */
export function createTower(): TowerHandles {
  const group = new Group();
  const uTime = { value: 0 };

  // --- Drum ---------------------------------------------------------------
  const drum = new Mesh(
    new CylinderGeometry(TOWER_RADIUS - 1.4, TOWER_RADIUS, TOWER_TOP, 72, 1, false),
    createStripeMaterial({
      colorA: PAINT.cream,
      colorB: PAINT.red,
      stripes: 22,
      twist: -0.035, // climbs the way the slide falls
      wear: 0.02
    })
  );
  drum.position.y = TOWER_TOP / 2;
  addOutline(drum, 0.7);
  group.add(drum);

  // Boarded-up base band so the drum meets the plinth in something solid.
  const skirt = new Mesh(
    new CylinderGeometry(TOWER_RADIUS + 0.35, TOWER_RADIUS + 0.6, 6, 72, 1, true),
    toon({ color: 0x8a3128, side: DoubleSide })
  );
  skirt.position.y = 3;
  group.add(skirt);

  const plinth = new Mesh(
    new CylinderGeometry(SLIDE_RADIUS + 5, SLIDE_RADIUS + 5.6, 0.6, 96),
    toon({ color: 0xb9ab95 })
  );
  plinth.position.y = 0.3;
  group.add(plinth);

  // --- Roof ---------------------------------------------------------------
  const roof = new Mesh(
    new ConeGeometry(TOWER_RADIUS + 1.2, ROOF_HEIGHT, 72, 1),
    createStripeMaterial({ colorA: PAINT.red, colorB: PAINT.cream, stripes: 18, wear: 0.05 })
  );
  roof.position.y = TOWER_TOP + ROOF_HEIGHT / 2;
  addOutline(roof, 0.7);
  group.add(roof);

  const eave = new Mesh(
    new TorusGeometry(TOWER_RADIUS + 0.4, 0.55, 10, 96),
    toon({ color: PAINT.gold })
  );
  eave.rotation.x = Math.PI / 2;
  eave.position.y = TOWER_TOP;
  group.add(eave);

  // Gold finial + glare, flagpole and a flag that waves in the shader.
  const finial = new Mesh(new SphereGeometry(1.7, 24, 16), toon({ color: PAINT.gold, emissive: 0x4a3808 }));
  finial.position.y = TOWER_TOP + ROOF_HEIGHT + 1.2;
  addOutline(finial, 0.12);
  group.add(finial);
  const glare = makeGlow(0xfff0b0, 14, 0.35);
  glare.position.copy(finial.position);
  group.add(glare);

  const pole = new Mesh(
    new CylinderGeometry(0.14, 0.14, 12, 8),
    toon({ color: 0xf0f0f0 })
  );
  pole.position.y = finial.position.y + 6.5;
  group.add(pole);

  const flagMaterial = new ShaderMaterial({
    fog: true,
    side: DoubleSide,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime }]),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      uniform float uTime;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec3 p = position;
        float wave = sin(p.x * 1.4 - uTime * 6.0) * 0.35 * uv.x + sin(p.x * 3.1 - uTime * 9.0) * 0.12 * uv.x;
        p.z += wave;
        vNormal = normalize(mat3(modelMatrix) * normalize(vec3(0.0, 0.0, 1.0) + vec3(-cos(p.x * 1.4 - uTime * 6.0) * 0.4 * uv.x, 0.0, 0.0)));
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      #include <fog_pars_fragment>
      ${LIGHT_GLSL}
      void main() {
        vec3 red = vec3(0.78, 0.06, 0.05);
        vec3 cream = vec3(0.98, 0.90, 0.74);
        // A cream cross on red — seaside pennant.
        float cross = step(abs(vUv.y - 0.5), 0.12) + step(abs(vUv.x - 0.35), 0.08);
        vec3 albedo = mix(red, cream, clamp(cross, 0.0, 1.0));
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        gl_FragColor = vec4(shade(albedo, n), 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  });
  const flag = new Mesh(new PlaneGeometry(7.5, 4.2, 24, 6), flagMaterial);
  flag.position.set(3.85, pole.position.y + 3.4, 0);
  group.add(flag);

  // --- Balcony (start) ----------------------------------------------------
  // A wide walkway around the tower top. It stops where the spiral begins
  // so the slide can drop away clear of it.
  const startAngle = helterPath.segments[0].angle0;
  const helixStartAngle = startAngle + BAY_RUN / SLIDE_RADIUS;
  const balconyInner = TOWER_RADIUS - 0.3;
  const balconyOuter = SLIDE_RADIUS + TRACK_WIDTH / 2 + 1.1;
  const balconyA0 = helixStartAngle - 4.1;
  const balconyA1 = helixStartAngle + 0.02;
  const balcony = new Mesh(
    annulusSector(balconyInner, balconyOuter, balconyA0, balconyA1, 72),
    toon({ color: 0xead9bd, side: DoubleSide })
  );
  balcony.position.y = TIER_HEIGHTS[0] - 0.04;
  group.add(balcony);
  const balconyEdge = new Mesh(
    annulusSector(balconyOuter - 0.35, balconyOuter, balconyA0, balconyA1, 72),
    toon({ color: PAINT.red, side: DoubleSide })
  );
  balconyEdge.position.y = TIER_HEIGHTS[0] - 0.02;
  group.add(balconyEdge);

  // Railing: a gold rail on white posts along the outer edge, and closed
  // ends so nobody wanders off the back of the walkway.
  const railMat = toon({ color: PAINT.gold });
  const postMat = toon({ color: 0xf6f1e6 });
  const railRadius = balconyOuter - 0.18;
  const rail = new Mesh(
    new TorusGeometry(railRadius, 0.06, 8, 96, balconyA1 - balconyA0),
    railMat
  );
  rail.rotation.x = Math.PI / 2;
  rail.rotation.z = balconyA0; // torus arc starts at +X; spin to the sector start
  rail.position.y = TIER_HEIGHTS[0] + 1.05;
  group.add(rail);
  const midRail = rail.clone();
  midRail.position.y = TIER_HEIGHTS[0] + 0.55;
  group.add(midRail);

  const postCount = 26;
  const posts = new InstancedMesh(new CylinderGeometry(0.05, 0.05, 1.1, 6), postMat, postCount + 6);
  const m = new Matrix4();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);
  const p = new Vector3();
  let k = 0;
  for (let i = 0; i <= postCount; i++) {
    const a = balconyA0 + ((balconyA1 - balconyA0) * i) / postCount;
    p.set(Math.cos(a) * railRadius, TIER_HEIGHTS[0] + 0.55, Math.sin(a) * railRadius);
    m.compose(p, q, one);
    posts.setMatrixAt(k++, m);
  }
  // Back wall of the walkway: a few posts across the closed end.
  for (let i = 1; i <= 5; i++) {
    const r = balconyInner + ((railRadius - balconyInner) * i) / 5;
    p.set(Math.cos(balconyA0) * r, TIER_HEIGHTS[0] + 0.55, Math.sin(balconyA0) * r);
    m.compose(p, q, one);
    posts.setMatrixAt(k++, m);
  }
  posts.count = k;
  group.add(posts);
  const endRail = new Mesh(
    new CylinderGeometry(0.06, 0.06, railRadius - balconyInner, 6),
    railMat
  );
  endRail.rotation.z = Math.PI / 2;
  endRail.rotation.y = -balconyA0;
  const midR = (railRadius + balconyInner) / 2;
  endRail.position.set(Math.cos(balconyA0) * midR, TIER_HEIGHTS[0] + 1.05, Math.sin(balconyA0) * midR);
  group.add(endRail);

  // Landing bays: a broader shelf under each tier change so the stop reads
  // as arriving somewhere, not just pausing mid-slide.
  const bayMat = toon({ color: 0xead9bd, side: DoubleSide });
  const bayTrim = toon({ color: PAINT.red, side: DoubleSide });
  helterPath.tiers.forEach((_tier, i) => {
    if (i === 0) return; // the balcony is tier one's bay
    const seg = helterPath.segments[i * 3]; // run-up segment of this tier
    const a0 = seg.angle0 - 3.2 / SLIDE_RADIUS; // includes the arrival strip behind it
    const a1 = seg.angle0 + seg.length / SLIDE_RADIUS + 0.02;
    const outer = SLIDE_RADIUS + TRACK_WIDTH / 2 + 0.9;
    const bay = new Mesh(annulusSector(TOWER_RADIUS - 0.3, outer, a0, a1, 24), bayMat);
    bay.position.y = seg.y0 - 0.06;
    group.add(bay);
    const trim = new Mesh(annulusSector(outer - 0.3, outer, a0, a1, 24), bayTrim);
    trim.position.y = seg.y0 - 0.04;
    group.add(trim);
  });

  return { group, uniforms: { uTime } };
}
