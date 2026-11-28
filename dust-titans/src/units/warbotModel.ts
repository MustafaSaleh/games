import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * The Warbot's 3D model (Meshy image-to-3D, Mixamo rig; source in art/). Loaded once, the
 * first time a Warbot appears; every Warbot gets its own skinned clone and animation mixer.
 */
const URL = `${import.meta.env.BASE_URL}models/warbot.glb`;

/** height of the model in the game (m), matching the Warbot's hit box and gun height */
export const WARBOT_HEIGHT = 6.4;

let cache: Promise<GLTF | null> | null = null;

export function loadWarbotModel(): Promise<GLTF | null> {
  cache ??= new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync(URL)
    .catch((e) => {
      console.warn('warbot model failed to load, using the built-in one', e);
      return null;
    });
  return cache;
}

export interface WarbotRig {
  /** feet on y = 0, centred, facing +z, WARBOT_HEIGHT tall */
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  bones: Map<string, THREE.Bone>;
  /** bind-pose rotations (the mesh as modelled: gatling and fist straight) */
  rest: Map<THREE.Bone, THREE.Quaternion>;
  materials: THREE.Material[];
}

/** a new skinned copy, tinted a little toward `tint` */
export function makeWarbotRig(gltf: GLTF, tint: number, amount: number): WarbotRig {
  const model = cloneSkinned(gltf.scene);
  const bones = new Map<string, THREE.Bone>();
  const materials: THREE.Material[] = [];
  const rest = new Map<THREE.Bone, THREE.Quaternion>();
  const tintC = new THREE.Color(0xffffff).lerp(new THREE.Color(tint), amount);
  model.traverse((o) => {
    const b = o as THREE.Bone;
    if (b.isBone) {
      bones.set(b.name.replace(/^mixamorig:?/, ''), b);
      rest.set(b, b.quaternion.clone());
    }
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.frustumCulled = false;
      const mat = (m.material as THREE.MeshStandardMaterial).clone();
      mat.color.copy(tintC);
      // the arenas have no environment map, so shiny metal renders almost black: keep it mostly matte
      mat.metalness = Math.min(mat.metalness, 0.2);
      mat.roughness = Math.max(mat.roughness, 0.7);
      if (mat.map) {
        mat.emissiveMap = mat.map; // a soft self-light so the olive armour reads in dark arenas
        mat.emissive.set(0xffffff);
        mat.emissiveIntensity = 0.22;
      }
      m.material = mat;
      materials.push(mat);
    }
  });
  const holder = new THREE.Group();
  holder.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const s = WARBOT_HEIGHT / Math.max(0.01, size.y);
  // centre on the hips (the gatling sticks out in front, so the box centre is too far forward)
  const hips = bones.get('Hips')?.getWorldPosition(new THREE.Vector3()) ?? box.getCenter(new THREE.Vector3());
  model.position.set(-hips.x * s, -box.min.y * s, -hips.z * s);
  model.scale.multiplyScalar(s);
  const clips = new Map(gltf.animations.map((c) => [c.name, c]));
  return { root: holder, mixer: new THREE.AnimationMixer(model), clips, bones, rest, materials };
}
