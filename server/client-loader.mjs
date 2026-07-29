import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Клиентские модули написаны для браузера и импортируют зависимости по абсолютным путям, которые
// раздаёт сервер. Чтобы прогонять их в Node без браузера и без сборщика, подменяем эти пути на
// настоящие файлы на диске.
const threeUrl = pathToFileURL(path.resolve('node_modules/three/build/three.module.js')).href;
const addonsRoot = pathToFileURL(path.resolve('node_modules/three/examples/jsm') + path.sep).href;
const sharedRoot = pathToFileURL(path.resolve('shared') + path.sep).href;

// В браузере эти же соответствия задаёт import map в client/index.html — здесь мы просто повторяем
// их для Node. Важно, чтобы 'three' резолвился ровно в один файл: две копии Three.js в одной
// программе ломают проверки instanceof.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: threeUrl, shortCircuit: true };
  if (specifier.startsWith('three/addons/'))
    return {
      url: new URL(specifier.slice('three/addons/'.length), addonsRoot).href,
      shortCircuit: true
    };
  if (specifier.startsWith('/shared/'))
    return { url: new URL(specifier.slice('/shared/'.length), sharedRoot).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
