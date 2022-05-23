
import {css, customElement, html, LitElement, property} from 'lit-element';
import {ScenarioConfig} from '../../common.js';
// @ts-ignore
import Rn from '../../../node_modules/rhodonite/dist/esm/index.mjs';

const $isRhodoniteInitDone = Symbol('isRhodoniteInitDone');
const $updateSize = Symbol('updateSize');
const $updateScenario = Symbol('updateScenario');
const $canvas = Symbol('canvas');

@customElement('rhodonite-viewer')
export class RhodoniteViewer extends LitElement {
  @property({type: Object}) scenario: ScenarioConfig|null = null;
  private[$canvas]: HTMLCanvasElement|null;
  private[$isRhodoniteInitDone] = false;

  static get styles() {
      return css`
  :host {
    display: block;
  }
  `;
  }

  render() {
    return html`<canvas id="canvas"></canvas>`;
  }

  updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);
    this[$updateSize]();

    if (changedProperties.has('scenario') && this.scenario != null) {
      this[$updateScenario](this.scenario);
    }
  }

  private async[$updateScenario](scenario: ScenarioConfig) {
    const script = document.createElement("script");
    script.src = "https://storage.googleapis.com/emadurandal-3d-public.appspot.com/rhodonite/vendor/ibl_prefiltering_wasm.js";
    document.head.appendChild(script);
    script.onload = async () => {
      if (this[$isRhodoniteInitDone] === false) {
        this[$canvas] = this.shadowRoot!.querySelector('canvas');
        await Rn.System.init({
          approach: Rn.ProcessApproach.UniformWebGL2,
          canvas: this[$canvas] as HTMLCanvasElement,
        });
        this[$isRhodoniteInitDone] === true;
      }

      this[$updateSize]();

      // expressions
      const expressions = [];

      // camera
      const cameraEntity = Rn.EntityHelper.createCameraEntity();
      const cameraComponent = cameraEntity.getCamera();
      // cameraComponent.zNear = 0.1;
      // cameraComponent.zFar = 1000.0;
      // cameraComponent.setFovyAndChangeFilmSize(scenario.verticalFoV);
      // cameraComponent.setFovyAndChangeFocalLength(scenario.verticalFoV);
      cameraComponent.fovyInner = scenario.verticalFoV;
      cameraComponent.aspect = scenario.dimensions.width / scenario.dimensions.height;

      // gltf
      const mainExpression = await Rn.GltfImporter.import(
        scenario.model,
        {
          cameraComponent: cameraComponent,
          defaultMaterialHelperArgumentArray: [
            {
              makeOutputSrgb: false,
            },
          ],
        }
      );
      expressions.push(mainExpression);

      // post effects
      const expressionPostEffect = new Rn.Expression();
      expressions.push(expressionPostEffect);

      // gamma correction (and super sampling)
      const mainRenderPass = mainExpression.renderPasses[0];
      mainRenderPass.cameraComponent = cameraComponent;
      Rn.CameraComponent.current = cameraComponent.componentSID;

      const gammaTargetFramebuffer =
        Rn.RenderableHelper.createTexturesForRenderTarget(scenario.dimensions.width, scenario.dimensions.height, 1, {});
      mainRenderPass.setFramebuffer(gammaTargetFramebuffer);
      mainRenderPass.toClearColorBuffer = true;
      mainRenderPass.toClearDepthBuffer = true;

      const postEffectCameraEntity = createPostEffectCameraEntity();
      const postEffectCameraComponent = postEffectCameraEntity.getCamera();

      const gammaCorrectionMaterial =
        Rn.MaterialHelper.createGammaCorrectionMaterial();
      const gammaCorrectionRenderPass = createPostEffectRenderPass(
        gammaCorrectionMaterial,
        postEffectCameraComponent
      );

      const split = scenario.lighting.split('.');
      const ext = split[split.length - 1];
      if (ext === 'hdr') {
        const prefilterObj = await prefilterFromUri(scenario.lighting);
        setupPrefilteredIBLTexture(prefilterObj);
      }
      
      setTextureParameterForMeshComponents(
        gammaCorrectionRenderPass.meshComponents!,
        Rn.ShaderSemantics.BaseColorTexture,
        gammaTargetFramebuffer.getColorAttachedRenderTargetTexture(0)
      );

      expressionPostEffect.addRenderPasses([gammaCorrectionRenderPass]);

      // cameraController
      // const mainCameraControllerComponent = cameraEntity.getCameraController();
      // const controller = mainCameraControllerComponent.controller as Rn.OrbitCameraController;
      // controller.setTarget(mainRenderPass.sceneTopLevelGraphComponents[0].entity);
      // controller.setFixedDollyTrue(scenario.orbit.radius);
      // controller.dolly = 0.5;
      // controller.rotX = scenario.orbit.theta;
      // controller.rotY = scenario.orbit.phi - 90;

      // const sceneTopLevelGraphComponents = mainRenderPass.sceneTopLevelGraphComponents as Rn.SceneGraphComponent[]
      // const rootGroup = sceneTopLevelGraphComponents![0].entity as Rn.ISceneGraphEntity
      // const aabb = rootGroup.getSceneGraph().calcWorldAABB();
      
      // for (const sgc of mainRenderPass.sceneTopLevelGraphComponents) {
      //   sgc.transform = Rn.Vector3.multiply(aabb.centerPoint, -1);
      // }

      // mainRenderPass.setViewport(Rn.Vector4.fromCopy4(0, 0, scenario.dimensions.width, scenario.dimensions.height));
      Rn.MeshRendererComponent.isViewFrustumCullingEnabled = false;
      const {target, orbit} = this.scenario!;

      const center = [target.x, target.y, target.z];

      const theta = (orbit.theta) * Math.PI / 180;
      const phi = (orbit.phi) * Math.PI / 180;
      const radiusSinPhi = orbit.radius * Math.sin(phi);
      const eye = [
        radiusSinPhi * Math.sin(theta) + target.x,
        orbit.radius * Math.cos(phi) + target.y,
        radiusSinPhi * Math.cos(theta) + target.z
      ];
      if (orbit.radius <= 0) {
        center[0] = eye[0] - Math.sin(phi) * Math.sin(theta);
        center[1] = eye[1] - Math.cos(phi);
        center[2] = eye[2] - Math.sin(phi) * Math.cos(theta);
      }
      const up = [0, 1, 0];

      // cameraEntity.translate = Rn.Vector3.fromCopyArray3(eye)
      cameraEntity.getCamera().eyeInner = Rn.Vector3.fromCopyArray3(eye);
      cameraEntity.getCamera().up = Rn.Vector3.fromCopyArray3(up);
      cameraEntity.getCamera().directionInner = Rn.Vector3.fromCopyArray3(center);
      // cameraEntity.getCamera().direction = Rn.Vector3.fromCopyArray3(center);
      cameraEntity.getCamera().primitiveMode = true;
      // cameraEntity.getCamera().setDirectionDirectly(Rn.Vector3.fromCopyArray3(center));

      // const modelRadius = aabb.lengthCenterToCorner;
      // const max = aabb.maxPoint;
      // const min = aabb.minPoint;
      // const modelRadius = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
      // const far = 2 * Math.max(modelRadius, orbit.radius);
      // const near = far / 1000;
      cameraComponent.zNear = 0.0001;
      cameraComponent.zFar = 10000;
      // lighting
      // setIBL('./../../../assets/ibl/papermill');
      Rn.System.process(expressions);

      requestAnimationFrame(() => {
      this.dispatchEvent(
        // This notifies the framework that the model is visible and the
        // screenshot can be taken
        new CustomEvent('model-visibility', {detail: {visible: true}}));
      });
      
    }
  }

  private[$updateSize]() {
    if (this[$canvas] == null || this.scenario == null) {
      return;
    }

    const canvas = this[$canvas]!;
    const {dimensions} = this.scenario;

    const dpr = window.devicePixelRatio;
    const width = dimensions.width * dpr;
    const height = dimensions.height * dpr;

    Rn.System.resizeCanvas(width, height);

    // /canvas.width = width;
    //canvas.height = height;
    canvas.style.width = `${dimensions.width}px`;
    canvas.style.height = `${dimensions.height}px`;
  }
}

// function setIBL(baseUri: string) {
//   const specularCubeTexture = new Rn.CubeTexture();
//   specularCubeTexture.baseUriToLoad = baseUri + '/specular/specular';
//   specularCubeTexture.isNamePosNeg = true;
//   specularCubeTexture.hdriFormat = Rn.HdriFormat.RGBE_PNG;
//   specularCubeTexture.mipmapLevelNumber = 10;

//   const diffuseCubeTexture = new Rn.CubeTexture();
//   diffuseCubeTexture.baseUriToLoad = baseUri + '/diffuse/diffuse';
//   diffuseCubeTexture.hdriFormat = Rn.HdriFormat.RGBE_PNG;
//   diffuseCubeTexture.mipmapLevelNumber = 1;
//   diffuseCubeTexture.isNamePosNeg = true;

//   const meshRendererComponents = Rn.ComponentRepository.getComponentsWithType(
//     Rn.MeshRendererComponent
//   ) as Rn.MeshRendererComponent[];
//   for (let i = 0; i < meshRendererComponents.length; i++) {
//     const meshRendererComponent = meshRendererComponents[i];
//     meshRendererComponent.specularCubeMap = specularCubeTexture;
//     meshRendererComponent.diffuseCubeMap = diffuseCubeTexture;
//   }
// }

function createPostEffectRenderPass(
  material: Rn.Material,
  cameraComponent: Rn.CameraComponent
) {
  const boardPrimitive = new Rn.Plane();
  boardPrimitive.generate({
    width: 1,
    height: 1,
    uSpan: 1,
    vSpan: 1,
    isUVRepeat: false,
    material,
  });

  const boardMesh = new Rn.Mesh();
  boardMesh.addPrimitive(boardPrimitive);

  const boardEntity = Rn.EntityHelper.createMeshEntity();
  boardEntity.getTransform().rotate = Rn.Vector3.fromCopyArray([
    Math.PI / 2,
    0.0,
    0.0,
  ]);
  boardEntity.getTransform().translate = Rn.Vector3.fromCopyArray([
    0.0, 0.0, -0.5,
  ]);
  const boardMeshComponent = boardEntity.getMesh();
  boardMeshComponent.setMesh(boardMesh);

  const renderPass = new Rn.RenderPass();
  renderPass.toClearColorBuffer = false;
  renderPass.cameraComponent = cameraComponent;
  renderPass.addEntities([boardEntity]);

  return renderPass;
}


function createPostEffectCameraEntity() {
  const cameraEntity = Rn.EntityHelper.createCameraEntity();
  const cameraComponent = cameraEntity.getCamera();
  cameraComponent.zNearInner = 0.5;
  cameraComponent.zFarInner = 2.0;
  return cameraEntity;
}

function setTextureParameterForMeshComponents(
  meshComponents: Rn.MeshComponent[],
  shaderSemantic: Rn.ShaderSemanticsEnum,
  value: any
) {
  for (let i = 0; i < meshComponents.length; i++) {
    const mesh = meshComponents[i].mesh;
    if (!mesh) continue;

    const primitiveNumber = mesh.getPrimitiveNumber();
    for (let j = 0; j < primitiveNumber; j++) {
      const primitive = mesh.getPrimitiveAt(j);
      primitive.material.setTextureParameter(shaderSemantic, value);
    }
  }
}
declare const wasm_bindgen: any;
let initPrefilteringWasmPromise: Promise<unknown>;
let glPrefiltering: WebGLRenderingContext;

function initPrefilteringWasm() {
  return new Promise(resolve => {
    if (initPrefilteringWasmPromise != null) {
      // already initialized
      initPrefilteringWasmPromise.then(() => {
        resolve();
      });
    }

    const uri = 'https://storage.googleapis.com/emadurandal-3d-public.appspot.com/rhodonite/vendor/ibl_prefiltering_wasm_bg.wasm'

    initPrefilteringWasmPromise = wasm_bindgen(uri).then(() => {
      const canvas = document.createElement('canvas') as HTMLCanvasElement
      glPrefiltering = canvas.getContext('webgl') as WebGLRenderingContext
      const {init_webgl_extensions} = wasm_bindgen
      init_webgl_extensions(glPrefiltering)

      resolve();
    }) as Promise<void>

  }) as Promise<void>;
}

async function prefilterFromUri(hdrFileUri: string) {
  await initPrefilteringWasm()

  const {request_binary, CubeMapPrefilter} = wasm_bindgen

  const cubeMapSize = 512
  const irradianceCubeMapSize = 32
  const pmremCubeMapSize = 128
  const pmremCubeMapMipCount = 8
  const brdfLutSize = 512
  const sample_count = 1024;
  const prefilter = new CubeMapPrefilter(glPrefiltering, cubeMapSize, irradianceCubeMapSize, pmremCubeMapSize, pmremCubeMapMipCount, brdfLutSize, sample_count)

  const hdrImageData = await request_binary(hdrFileUri)
  prefilter.load_hdr_image(glPrefiltering, hdrImageData)
  prefilter.process(glPrefiltering)

  return prefilter
}

export function setupPrefilteredIBLTexture(prefilter: any) {
  const specularCubeTexture = new Rn.CubeTexture()
  const specularTextureTypedArrayImages = getSpecularCubeTextureTypedArrays(prefilter)
  specularCubeTexture.mipmapLevelNumber = specularTextureTypedArrayImages.length
  const specularTextureSize = getSpecularCubeTextureSize(prefilter, 0)
  specularCubeTexture.generateTextureFromTypedArrays(
    specularTextureTypedArrayImages,
    specularTextureSize,
    specularTextureSize
  )
  specularCubeTexture.hdriFormat = Rn.HdriFormat.RGBE_PNG

  const diffuseCubeTexture = new Rn.CubeTexture()
  const diffuseTextureTypedArrayImages = getDiffuseCubeTextureTypedArrays(prefilter)
  const diffuseTextureSize = getDiffuseCubeTextureSize(prefilter)
  diffuseCubeTexture.generateTextureFromTypedArrays(
    diffuseTextureTypedArrayImages,
    diffuseTextureSize,
    diffuseTextureSize
  )
  diffuseCubeTexture.hdriFormat = Rn.HdriFormat.RGBE_PNG;

  attachIBLTextureToAllMeshComponents(diffuseCubeTexture, specularCubeTexture);

  return [diffuseCubeTexture, specularCubeTexture];
}

export function getSpecularCubeTextureTypedArrays(prefilter: any) {
  const specularTextureTypedArrays = [];
  const mipCount = prefilter.pmrem_cubemap_mip_count();

  for (let mipLevel = 0; mipLevel < mipCount; mipLevel++) {
    specularTextureTypedArrays.push(
      {
        posX: prefilter.pmrem_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_POSITIVE_X, mipLevel),
        negX: prefilter.pmrem_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_NEGATIVE_X, mipLevel),
        posY: prefilter.pmrem_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_POSITIVE_Y, mipLevel),
        negY: prefilter.pmrem_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_NEGATIVE_Y, mipLevel),
        posZ: prefilter.pmrem_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_POSITIVE_Z, mipLevel),
        negZ: prefilter.pmrem_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_NEGATIVE_Z, mipLevel)
      }
    );
  }

  return specularTextureTypedArrays;
}

export function getDiffuseCubeTextureTypedArrays(prefilter: any) {
  return [
    {
      posX: prefilter.irradiance_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_POSITIVE_X),
      negX: prefilter.irradiance_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_NEGATIVE_X),
      posY: prefilter.irradiance_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_POSITIVE_Y),
      negY: prefilter.irradiance_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_NEGATIVE_Y),
      posZ: prefilter.irradiance_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_POSITIVE_Z),
      negZ: prefilter.irradiance_cubemap_texture_to_arrybuffer(glPrefiltering, glPrefiltering.TEXTURE_CUBE_MAP_NEGATIVE_Z)
    }
  ]
}

export function getEnvCubeTextureSize(prefilter: any) {
  return prefilter.hdr_cubemap_texture_size()
}

export function getDiffuseCubeTextureSize(prefilter: any) {
  return prefilter.irradiance_cubemap_texture_size()
}

export function getSpecularCubeTextureSize(prefilter: any, mipLevel: number) {
  return prefilter.pmrem_cubemap_texture_size(mipLevel)
}

export function attachIBLTextureToAllMeshComponents(diffuseCubeTexture: Rn.CubeTexture, specularCubeTexture: Rn.CubeTexture) {
  const meshRendererComponents = Rn.ComponentRepository.getComponentsWithType(Rn.MeshRendererComponent) as Rn.MeshRendererComponent[]
  for (let i = 0; i < meshRendererComponents.length; i++) {
    const meshRendererComponent = meshRendererComponents[i];
    meshRendererComponent.specularCubeMap = specularCubeTexture;
    meshRendererComponent.diffuseCubeMap = diffuseCubeTexture;
  }
}