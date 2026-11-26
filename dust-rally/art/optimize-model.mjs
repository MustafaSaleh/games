// Shrinks a character GLB for the game: WebP textures (base colour 1024px, normal/roughness 512px),
// quantised + meshopt-compressed geometry. Usage (from any scratch folder):
//   npm i @gltf-transform/core@4.2.1 @gltf-transform/functions@4.2.1 @gltf-transform/extensions@4.2.1 meshoptimizer@0.22.0 sharp@0.34.3
//   node optimize-model.mjs source/mody-rigged-mixamo.glb ../public/models/mody.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, quantize, meshopt, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
const [,, inp, out] = process.argv;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inp);
const root = doc.getRoot();
console.log('nodes:', root.listNodes().map(n => n.getName()).slice(0, 80).join(', '));
console.log('skins joints:', root.listSkins()[0]?.listJoints().length);
for (const n of root.listScenes()[0].listChildren()) console.log('top', n.getName(), n.getScale(), n.getRotation());
await doc.transform(
  dedup(), prune(), resample(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^baseColor/, resize: [1024, 1024], quality: 82 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^(normal|metallicRoughness)/, resize: [512, 512], quality: 80 }),
  quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(out, doc);
