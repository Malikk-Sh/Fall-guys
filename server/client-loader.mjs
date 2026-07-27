import path from 'node:path';
import {pathToFileURL} from 'node:url';

const threeUrl=pathToFileURL(path.resolve('node_modules/three/build/three.module.js')).href;
export async function resolve(specifier,context,nextResolve){if(specifier==='/vendor/three.module.js')return{url:threeUrl,shortCircuit:true};return nextResolve(specifier,context)}
