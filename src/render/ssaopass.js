// Screen-space ambient occlusion.
//
// The one thing missing from the frame that no amount of texture work fixes:
// contact. Without occlusion every tree trunk, crate and corpse sits on the
// ground like a sticker on glass, because the only shadow in the scene is the
// sun's and the sun cannot reach into the crease where two surfaces meet. AO is
// what puts objects *in* the world rather than on top of it.
//
// The implementation is the standard hemisphere-kernel SSAO, with three
// concessions to running inside a game rather than a demo:
//
//   * The occlusion buffer is computed at half resolution and upsampled. AO is
//     a low-frequency signal; paying full-rate for it is most of the cost and
//     almost none of the look.
//   * Normals come from a depth-only prepass with an override material, so the
//     pass owns its inputs and does not require the main render target to carry
//     a depth texture (which it cannot, while it is multisampled).
//   * The kernel is rotated per-pixel by a hash rather than a noise texture,
//     then blurred, which trades a texture fetch for an ALU op and removes the
//     tiling artefact a 4x4 noise tile leaves behind.

import * as THREE from '../../vendor/three.module.js';
import { Pass, FullScreenQuad } from '../../vendor/postprocessing/Pass.js';

/** Hemisphere samples. More is smoother and linearly more expensive. */
const KERNEL_SIZE = 16;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ---------------------------------------------------------------- occlusion
const AO_FRAG = /* glsl */`
  #include <packing>

  varying vec2 vUv;

  uniform sampler2D tDepth;
  uniform sampler2D tNormal;
  uniform mat4 uProjection;
  uniform mat4 uInverseProjection;
  uniform float uNear;
  uniform float uFar;
  uniform float uRadius;
  uniform float uBias;
  uniform vec3 uKernel[${KERNEL_SIZE}];

  float readDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

  /* View-space position of the fragment behind this uv. */
  vec3 viewPosition(vec2 uv, float depth) {
    float viewZ = perspectiveDepthToViewZ(depth, uNear, uFar);
    // Undo the perspective divide, then the projection.
    float clipW = uProjection[2][3] * viewZ + uProjection[3][3];
    vec4 clip = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0) * clipW;
    return (uInverseProjection * clip).xyz;
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    float depth = readDepth(vUv);

    // Nothing was drawn here -- it is the sky. The sky cannot be occluded, and
    // letting it fall through would draw a dark halo around every silhouette.
    if (depth >= 1.0) { gl_FragColor = vec4(1.0); return; }

    vec3 origin = viewPosition(vUv, depth);
    vec3 normal = normalize(texture2D(tNormal, vUv).rgb * 2.0 - 1.0);

    // Lift the sampling origin off the surface along its own normal.
    //
    // Without this a face seen at a grazing angle occludes itself: the depth
    // buffer changes fast across such a face, so half the hemisphere samples
    // land behind the very surface they were taken from and are counted as
    // occluders. It renders as a solid black slab standing in a lit room --
    // which is exactly what the shelves were doing. Scaling the offset with
    // distance keeps it effective far from the camera, where a fixed epsilon
    // is smaller than one depth quantum.
    origin += normal * (0.02 + abs(origin.z) * 0.004);

    // Per-pixel rotation of the kernel. Without it the same 16 offsets are
    // reused everywhere and the result bands; with it the noise is spread to
    // high frequency where the blur below can remove it.
    float angle = hash(vUv * 1000.0) * 6.2831853;
    vec3 randomVec = vec3(cos(angle), sin(angle), 0.0);

    // Gram-Schmidt: an orthonormal basis with the surface normal as +Z, so the
    // kernel is always sampled into the hemisphere above the surface.
    vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
    vec3 bitangent = cross(normal, tangent);
    mat3 tbn = mat3(tangent, bitangent, normal);

    float occlusion = 0.0;
    for (int i = 0; i < ${KERNEL_SIZE}; i++) {
      vec3 samplePos = origin + tbn * uKernel[i] * uRadius;

      // Where does that point land on screen?
      vec4 offset = uProjection * vec4(samplePos, 1.0);
      offset.xyz /= offset.w;
      vec2 sampleUv = offset.xy * 0.5 + 0.5;

      // Off-screen samples have no depth to compare against; counting them as
      // unoccluded is what keeps the screen edges from darkening.
      if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;

      float sampleDepth = readDepth(sampleUv);
      float sampleViewZ = perspectiveDepthToViewZ(sampleDepth, uNear, uFar);

      // View-space Z is negative going away from the camera, so "in front of"
      // is a greater value. uBias lifts the comparison off the surface and is
      // what stops a flat plane self-occluding into a grey wash.
      if (sampleViewZ >= samplePos.z + uBias) {
        // Only count geometry that is actually near this pixel. Without the
        // range check a wall metres behind a foreground object occludes it.
        occlusion += smoothstep(0.0, 1.0, uRadius / abs(origin.z - sampleViewZ));
      }
    }

    gl_FragColor = vec4(vec3(1.0 - occlusion / float(${KERNEL_SIZE})), 1.0);
  }
`;

// --------------------------------------------------------------------- blur
// A plain separable-ish 3x3 box over the AO buffer. The kernel rotation above
// turns banding into per-pixel noise on purpose, and this is what pays that
// debt back.
const BLUR_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tAo;
  uniform vec2 uTexelSize;

  void main() {
    float sum = 0.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        sum += texture2D(tAo, vUv + vec2(float(x), float(y)) * uTexelSize).r;
      }
    }
    gl_FragColor = vec4(vec3(sum / 9.0), 1.0);
  }
`;

// ---------------------------------------------------------------- composite
const COMPOSITE_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tAo;
  uniform float uIntensity;
  uniform float uFloor;

  void main() {
    vec4 color = texture2D(tDiffuse, vUv);
    float ao = texture2D(tAo, vUv).r;
    // pow() shapes the falloff: the occlusion term is linear, but contact
    // shadows read better when the darkening bites late and hard.
    ao = pow(clamp(ao, 0.0, 1.0), uIntensity);

    // Floor it.
    //
    // Ambient occlusion is a shadowing *term*, not a light switch: a surface
    // out in the open should never be driven to black by it however the
    // sampling goes. Without the floor a flat face could reach full occlusion
    // and render as a black slab standing in a lit room -- which is precisely
    // what the shelves were doing, and the artefact was far worse than the
    // effect was worth. Clamping costs a little contact darkness in real
    // creases and makes the failure mode impossible.
    ao = mix(uFloor, 1.0, ao);
    gl_FragColor = vec4(color.rgb * ao, color.a);
  }
`;

/** Cosine-ish distributed hemisphere kernel, clustered toward the origin. */
function buildKernel(size) {
  const kernel = [];
  for (let i = 0; i < size; i++) {
    const v = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random(),            // +Z only: this is a hemisphere, not a sphere
    ).normalize();
    // Push samples toward the centre so occluders close to the surface -- the
    // ones that actually make contact shadows -- carry more of the weight.
    const scale = 0.1 + 0.9 * (i / size) ** 2;
    kernel.push(v.multiplyScalar(scale));
  }
  return kernel;
}

export class SSAOPass extends Pass {
  /**
   * @param scene  the scene to take depth and normals from
   * @param camera the perspective camera it is viewed with
   * @param width  full-resolution drawing buffer width
   */
  constructor(scene, camera, width, height) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = true;

    /** Sampling radius in world units. Roughly "how big is a crevice". */
    this.radius = 0.55;
    /** Depth offset that stops flat surfaces occluding themselves. */
    this.bias = 0.045;
    /** Exponent on the AO term; higher is a deeper, tighter contact shadow. */
    this.intensity = 1.5;
    /** Darkest AO may ever make a surface. Never zero -- see the composite. */
    this.floor = 0.55;

    /**
     * Objects hidden during the depth/normal prepass.
     *
     * `overrideMaterial` replaces a material wholesale, including its depth
     * settings -- so the sky dome, which is drawn with depthWrite off precisely
     * so it never occludes anything, would start writing depth here and hand
     * every sky pixel a surface to be occluded against. Anything additive or
     * depth-less belongs in this list.
     */
    this.exclude = [];

    // Depth + view normals, rendered once per frame at half resolution.
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));

    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.normalRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
    });

    this.aoRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.blurRT = this.aoRT.clone();

    this.normalMaterial = new THREE.MeshNormalMaterial();

    this.aoMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: AO_FRAG,
      uniforms: {
        tDepth: { value: depthTexture },
        tNormal: { value: this.normalRT.texture },
        uProjection: { value: new THREE.Matrix4() },
        uInverseProjection: { value: new THREE.Matrix4() },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uRadius: { value: this.radius },
        uBias: { value: this.bias },
        uKernel: { value: buildKernel(KERNEL_SIZE) },
      },
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tAo: { value: this.aoRT.texture },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
      },
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        tAo: { value: this.blurRT.texture },
        uIntensity: { value: this.intensity },
        uFloor: { value: this.floor },
      },
    });

    this.quad = new FullScreenQuad(null);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.normalRT.setSize(w, h);
    this.aoRT.setSize(w, h);
    this.blurRT.setSize(w, h);
    this.blurMaterial.uniforms.uTexelSize.value.set(1 / w, 1 / h);
  }

  render(renderer, writeBuffer, readBuffer) {
    // ---- depth + view normals -------------------------------------------
    const oldOverride = this.scene.overrideMaterial;
    const oldBackground = this.scene.background;
    const oldFog = this.scene.fog;
    this.scene.fog = null;
    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;

    // Hide the sky and anything else that must not become an occluder, then put
    // each one back exactly as it was -- an object already hidden for gameplay
    // reasons must stay hidden.
    const wasVisible = [];
    for (let i = 0; i < this.exclude.length; i++) {
      wasVisible.push(this.exclude[i].visible);
      this.exclude[i].visible = false;
    }

    renderer.setRenderTarget(this.normalRT);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);

    for (let i = 0; i < this.exclude.length; i++) {
      this.exclude[i].visible = wasVisible[i];
    }

    this.scene.overrideMaterial = oldOverride;
    this.scene.background = oldBackground;
    this.scene.fog = oldFog;

    // ---- occlusion -------------------------------------------------------
    const u = this.aoMaterial.uniforms;
    u.uProjection.value.copy(this.camera.projectionMatrix);
    u.uInverseProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uRadius.value = this.radius;
    u.uBias.value = this.bias;

    this.quad.material = this.aoMaterial;
    renderer.setRenderTarget(this.aoRT);
    renderer.clear();
    this.quad.render(renderer);

    // ---- blur ------------------------------------------------------------
    this.quad.material = this.blurMaterial;
    renderer.setRenderTarget(this.blurRT);
    renderer.clear();
    this.quad.render(renderer);

    // ---- multiply into the lit frame -------------------------------------
    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.uIntensity.value = this.intensity;
    this.compositeMaterial.uniforms.uFloor.value = this.floor;
    this.quad.material = this.compositeMaterial;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.quad.render(renderer);
  }

  dispose() {
    this.normalRT.dispose();
    this.aoRT.dispose();
    this.blurRT.dispose();
    this.normalMaterial.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}
