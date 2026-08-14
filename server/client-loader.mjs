import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Клиентские модули написаны для браузера и импортируют зависимости по абсолютным путям, которые
// раздаёт сервер. Чтобы прогонять их в Node без браузера и без сборщика, подменяем эти пути на
// настоящие файлы на диске.
//
// Корень считается от ЭТОГО файла, а не от рабочего каталога. Разница не теоретическая: server/
// остался отдельным пакетом со своим `npm start`, который запускает `node index.js` уже из server/.
// При таком запуске путь от cwd вёл в server/shared и server/node_modules/three — ни того, ни
// другого не существует, загрузчик падал, а bootstrap проглатывал ошибку: сервер поднимался вовсе
// без ботов, и понять почему было неоткуда.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threeUrl = pathToFileURL(path.join(root, 'node_modules/three/build/three.module.js')).href;
const addonsRoot = pathToFileURL(path.join(root, 'node_modules/three/examples/jsm') + path.sep).href;
const sharedRoot = pathToFileURL(path.join(root, 'shared') + path.sep).href;

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
