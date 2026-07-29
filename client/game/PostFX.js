import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Постобработка.
//
// Самый заметный прирост картинки на единицу кода. В сцене уже есть светящиеся объекты — арки
// чекпоинтов, финишная лента, стартовая полоса, — но без свечения они выглядели просто как цветные
// бруски. Bloom заставляет их действительно светиться и задаёт всей игре праздничный, «парковый» тон.
//
// Стоимость реальная, поэтому эффект включается только на высоком качестве. На слабых устройствах
// класс становится прозрачной обёрткой: render() просто вызывает обычную отрисовку, а вся остальная
// игра не знает, включена постобработка или нет.

// Базовая сила свечения. Всплески (финиш, активация кооп-механики) поднимают её через pulse(),
// после чего она сама возвращается к этому значению.
const BLOOM_BASE_STRENGTH = 0.75;

export class PostFX {
  constructor(renderer, scene, camera, quality = 'high') {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = null;
    this.bloom = null;
    this.setQuality(quality);
  }

  get enabled() {
    return !!this.composer;
  }

  setQuality(quality) {
    const wanted = quality === 'high';
    if (wanted === this.enabled) return;
    if (!wanted) {
      this.dispose();
      return;
    }
    this.build();
  }

  build() {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Порог 2.2 — величина в ЛИНЕЙНОМ HDR, а не в привычных 0..1.
    //
    // Сцена освещена очень ярко (полусферический свет 2.45, солнце 2.85), поэтому в линейном
    // пространстве почти каждая поверхность заметно превышает единицу. С низким порогом в свечение
    // попадала вся картинка разом: цвета выцветали, небо бледнело, изображение превращалось в
    // молоко. При пороге 2.2 светятся только объекты со специально поднятой эмиссией — арки
    // чекпоинтов, финишная лента, разметка, — то есть ровно то, ради чего эффект и вводился.
    this.bloom = new UnrealBloomPass(size, BLOOM_BASE_STRENGTH, 0.35, 2.2);
    this.composer.addPass(this.bloom);

    // OutputPass выполняет тональную компрессию и перевод в sRGB последним шагом цепочки.
    //
    // Важно: renderer.toneMapping трогать НЕЛЬЗЯ. Three.js сам не применяет тональную компрессию
    // при отрисовке в render target (а именно туда рисует RenderPass), так что сцена попадает в
    // композитор в линейном HDR — как и нужно для честного свечения. При этом OutputPass читает
    // renderer.toneMapping, чтобы понять, какую кривую применить в конце. Если выставить здесь
    // NoToneMapping, компрессия не выполнится нигде и вся картинка окажется пересвеченной.
    this.composer.addPass(new OutputPass());
  }

  setSize(width, height) {
    this.composer?.setSize(width, height);
  }

  // Плавное усиление свечения — используется на финише и при активации кооп-механик.
  pulse(strength = 1) {
    if (this.bloom) this.bloom.strength = BLOOM_BASE_STRENGTH + strength * 0.7;
  }

  update(dt) {
    // Возврат свечения к обычному уровню после всплеска.
    if (this.bloom && this.bloom.strength > BLOOM_BASE_STRENGTH) {
      this.bloom.strength = Math.max(BLOOM_BASE_STRENGTH, this.bloom.strength - dt * 1.6);
    }
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (!this.composer) return;
    this.composer.dispose?.();
    this.bloom?.dispose?.();
    this.composer = null;
    this.bloom = null;
  }
}
