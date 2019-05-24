/**
 * @license
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {getBroadcastDims} from '../../ops/broadcast_util';
import * as util from '../../util';
import {getGlslDifferences, GLSL} from './glsl_version';
import * as shader_util from './shader_compiler_util';

export type ShapeInfo = {
  logicalShape: number[],
  texShape: [number, number],
  isUniform: boolean,
  isPacked: boolean,
  flatOffset: number
};

export type InputInfo = {
  name: string,
  shapeInfo: ShapeInfo
};

const MAX_TENSOR_RANK = 6;
const TEXSHAPE_RANK = 2;

export function makeShader(
    inputsInfo: InputInfo[], outputShape: ShapeInfo, userCode: string,
    usesPackedTextures: boolean): {source: string, key: string} {
  const prefixSnippets: string[] = [];
  inputsInfo.forEach(x => {
    const size = util.sizeFromShape(x.shapeInfo.logicalShape);

    // Snippet when we decided to upload the values as uniform.
    if (x.shapeInfo.isUniform) {
      prefixSnippets.push(
          `uniform float ${x.name}${size > 1 ? `[${size}]` : ''};`);
    } else {
      prefixSnippets.push(`uniform sampler2D ${x.name};`);
      prefixSnippets.push(`uniform int offset${x.name};`);
    }
  });
  const inputPrefixSnippet = prefixSnippets.join('\n');

  const inputSamplingSnippet =
      inputsInfo
          .map(x => getInputSamplingSnippet(x, outputShape, usesPackedTextures))
          .join('\n');
  const outTexShape = outputShape.texShape;
  const glsl = getGlslDifferences();
  const floatTextureSampleSnippet = getFloatTextureSampleSnippet(glsl);
  let outputSamplingSnippet = '';
  let floatTextureSetOutputSnippet: string;
  let shaderPrefix = getShaderPrefix(glsl);

  if (outputShape.isPacked) {
    outputSamplingSnippet +=
        getPackedOutputSamplingSnippet(outputShape.logicalShape, outTexShape);
    floatTextureSetOutputSnippet = getFloatTextureSetRGBASnippet(glsl);
  } else {
    outputSamplingSnippet +=
        getOutputSamplingSnippet(outputShape.logicalShape, outTexShape);
    floatTextureSetOutputSnippet = getFloatTextureSetRSnippet(glsl);
  }

  if (usesPackedTextures) {
    shaderPrefix += SHADER_PACKED_PREFIX;
  }

  const source = [
    shaderPrefix, floatTextureSampleSnippet, floatTextureSetOutputSnippet,
    inputPrefixSnippet, outputSamplingSnippet, inputSamplingSnippet, userCode
  ].join('\n');

  // TODO placeholder for new key constuction
  // const keyElements = [
  //   usesPackedTextures ? 'SHADER_PACKED_PREFIX_MARKER' : '',
  //   outputShape.isPacked ? 'PACKED_floatTextureSetOutputSnippet_MARKER' : '',
  //   inputPrefixSnippet,
  //   outputSamplingSnippet,
  //   inputSamplingSnippet,
  //   userCode,
  // ];
  // const key = keyElements.join('\n');
  const key = '';

  return {source, key};
}

function getSamplerFromInInfo(inInfo: InputInfo): string {
  const shape = inInfo.shapeInfo.logicalShape;
  switch (shape.length) {
    case 0:
      return getSamplerScalar(inInfo);
    case 1:
      return getSampler1D(inInfo);
    case 2:
      return getSampler2D(inInfo);
    case 3:
      return getSampler3D(inInfo);
    case 4:
      return getSampler4D(inInfo);
    case 5:
      return getSampler5D(inInfo);
    case 6:
      return getSampler6D(inInfo);
    default:
      throw new Error(
          `${shape.length}-D input sampling` +
          ` is not yet supported`);
  }
}

function getPackedSamplerFromInInfo(inInfo: InputInfo): string {
  const shape = inInfo.shapeInfo.logicalShape;
  switch (shape.length) {
    case 0:
      return getPackedSamplerScalar(inInfo);
    case 1:
      return getPackedSampler1D(inInfo);
    case 2:
      return getPackedSampler2D(inInfo);
    case 3:
      return getPackedSampler3D(inInfo);
    default:
      return getPackedSamplerND(inInfo);
  }
}

function getOutputShapeSnippet(
    texShape: [number, number], isPacked: boolean): string {
  let snip = `uniform int outputShape[${MAX_TENSOR_RANK}]; \n`;
  snip += `uniform int outputStrides[${MAX_TENSOR_RANK - 1}]; \n`;
  if (texShape) {
    snip += `uniform int outputTexShape[${TEXSHAPE_RANK}]; \n`;
  }
  if (texShape && isPacked) {
    snip += `uniform int outputPackedTexShape[${TEXSHAPE_RANK}]; \n`;
    snip += `uniform int outputTexelsInLogicalRow; \n`;
    snip += `uniform int outputTexelsInBatch; \n`;
  }
  return snip;
}

function getInputSamplingSnippet(
    inInfo: InputInfo, outShapeInfo: ShapeInfo,
    usesPackedTextures = false): string {
  let res = '';
  const inputName = inInfo.name;
  const shapeUniform = `shape${inputName}`;
  const texShapeUniform = `texShape${inputName}`;
  const stridesUniform = `strides${inputName}`;
  const packedTexShapeUniform = `packedTexShape${inputName}`;
  const valuesPerRowUniform = `valuesPerRow${inputName}`;
  const texelsInBatchUniform = `texelsInBatch${inputName}`;

  let sampler;
  if (usesPackedTextures) {
    sampler = getPackedSamplerFromInInfo(inInfo);
  } else {
    sampler = getSamplerFromInInfo(inInfo);
  }

  // Only add the uniform declaration if the sampler actually uses it
  // This is a nice to have as it makes the generated source more closely
  // match the source that will be linked into the webgl program (and thus make
  // for a good cache hit).
  if (inInfo.shapeInfo.logicalShape.length > 0) {
    if (sampler.indexOf(shapeUniform) !== -1) {
      res += `uniform int ${shapeUniform}[${MAX_TENSOR_RANK}]; \n`;
    }
    if (sampler.indexOf(stridesUniform) !== -1) {
      res += `uniform int ${stridesUniform}[${MAX_TENSOR_RANK - 1}]; \n`;
    }
    if (sampler.indexOf(texShapeUniform) !== -1) {
      res += `uniform int ${texShapeUniform}[${TEXSHAPE_RANK}]; \n`;
    }
    if (sampler.indexOf(packedTexShapeUniform) !== -1) {
      res += `uniform int ${packedTexShapeUniform}[${TEXSHAPE_RANK}]; \n`;
    }
    if (sampler.indexOf(valuesPerRowUniform) !== -1) {
      res += `uniform int ${valuesPerRowUniform}; \n`;
    }
    if (sampler.indexOf(texelsInBatchUniform) !== -1) {
      res += `uniform int ${texelsInBatchUniform}; \n`;
    }
  }
  res += sampler;

  const inShape = inInfo.shapeInfo.logicalShape;
  const outShape = outShapeInfo.logicalShape;
  if (inShape.length <= outShape.length) {
    if (usesPackedTextures) {
      res += getPackedSamplerAtOutputCoords(inInfo, outShapeInfo);
    } else {
      res += getSamplerAtOutputCoords(inInfo, outShapeInfo);
    }
  }
  return res;
}

function getPackedOutputSamplingSnippet(
    outShape: number[], outTexShape: [number, number]): string {
  const outputSamplingSnippet = getOutputShapeSnippet(outTexShape, true);
  switch (outShape.length) {
    case 0:
      return outputSamplingSnippet + getOutputScalarCoords();
    case 1:
      return outputSamplingSnippet +
          getOutputPacked1DCoords(outShape as [number], outTexShape);
    case 2:
      return outputSamplingSnippet +
          getOutputPacked2DCoords(outShape as [number, number], outTexShape);
    case 3:
      return outputSamplingSnippet +
          getOutputPacked3DCoords(
                 outShape as [number, number, number], outTexShape);
    default:
      return outputSamplingSnippet +
          getOutputPackedNDCoords(outShape, outTexShape);
  }
}

function getOutputSamplingSnippet(
    outShape: number[], outTexShape: [number, number]): string {
  const outputSamplingSnippet = getOutputShapeSnippet(outTexShape, false);
  switch (outShape.length) {
    case 0:
      return outputSamplingSnippet + getOutputScalarCoords();
    case 1:
      return outputSamplingSnippet +
          getOutput1DCoords(outShape as [number], outTexShape);
    case 2:
      return outputSamplingSnippet +
          getOutput2DCoords(outShape as [number, number], outTexShape);
    case 3:
      return outputSamplingSnippet +
          getOutput3DCoords(outShape as [number, number, number], outTexShape);
    case 4:
      return outputSamplingSnippet +
          getOutput4DCoords(
                 outShape as [number, number, number, number], outTexShape);
    case 5:
      return outputSamplingSnippet +
          getOutput5DCoords(
                 outShape as [number, number, number, number, number],
                 outTexShape);
    case 6:
      return outputSamplingSnippet +
          getOutput6DCoords(
                 outShape as [number, number, number, number, number, number],
                 outTexShape);
    default:
      throw new Error(
          `${outShape.length}-D output sampling is not yet supported`);
  }
}

function getFloatTextureSampleSnippet(glsl: GLSL): string {
  return `
    float sampleTexture(sampler2D textureSampler, vec2 uv) {
      return ${glsl.texture2D}(textureSampler, uv).r;
    }
  `;
}

function getFloatTextureSetRSnippet(glsl: GLSL): string {
  return `
    void setOutput(float val) {
      ${glsl.output} = vec4(val, 0, 0, 0);
    }
  `;
}

function getFloatTextureSetRGBASnippet(glsl: GLSL): string {
  return `
    void setOutput(vec4 val) {
      ${glsl.output} = val;
    }
  `;
}

function getShaderPrefix(glsl: GLSL): string {
  const SHADER_PREFIX = `${glsl.version}
    precision highp float;
    precision highp int;
    precision highp sampler2D;
    ${glsl.varyingFs} vec2 resultUV;
    ${glsl.defineOutput}
    const vec2 halfCR = vec2(0.5, 0.5);

    struct ivec5
    {
      int x;
      int y;
      int z;
      int w;
      int u;
    };

    struct ivec6
    {
      int x;
      int y;
      int z;
      int w;
      int u;
      int v;
    };

    uniform float NAN;
    #define isnan(value) isnan_custom(value)
    ${glsl.defineSpecialNaN}
    bvec4 isnan_custom(vec4 val) {
      return bvec4(isnan(val.x), isnan(val.y), isnan(val.z), isnan(val.w));
    }

    ${glsl.defineSpecialInf}
    ${glsl.defineRound}

    int imod(int x, int y) {
      return x - y * (x / y);
    }

    int idiv(int a, int b, float sign) {
      int res = a / b;
      int mod = imod(a, b);
      if (sign < 0. && mod != 0) {
        res -= 1;
      }
      return res;
    }

    //Based on the work of Dave Hoskins
    //https://www.shadertoy.com/view/4djSRW
    #define HASHSCALE1 443.8975
    float random(float seed){
      vec2 p = resultUV * seed;
      vec3 p3  = fract(vec3(p.xyx) * HASHSCALE1);
      p3 += dot(p3, p3.yzx + 19.19);
      return fract((p3.x + p3.y) * p3.z);
    }

    ${SAMPLE_1D_SNIPPET}
    ${SAMPLE_2D_SNIPPET}
    ${SAMPLE_3D_SNIPPET}
  `;

  return SHADER_PREFIX;
}

const SAMPLE_1D_SNIPPET = `
vec2 uvFromFlat(int texNumR, int texNumC, int index) {
  int texR = index / texNumC;
  int texC = index - texR * texNumC;
  return (vec2(texC, texR) + halfCR) / vec2(texNumC, texNumR);
}
vec2 packedUVfrom1D(int texNumR, int texNumC, int index) {
  int texelIndex = index / 2;
  int texR = texelIndex / texNumC;
  int texC = texelIndex - texR * texNumC;
  return (vec2(texC, texR) + halfCR) / vec2(texNumC, texNumR);
}
`;

const SAMPLE_2D_SNIPPET = `
vec2 packedUVfrom2D(int texelsInLogicalRow, int texNumR,
  int texNumC, int row, int col) {
  int texelIndex = (row / 2) * texelsInLogicalRow + (col / 2);
  int texR = texelIndex / texNumC;
  int texC = texelIndex - texR * texNumC;
  return (vec2(texC, texR) + halfCR) / vec2(texNumC, texNumR);
}
`;

const SAMPLE_3D_SNIPPET = `
vec2 packedUVfrom3D(int texNumR, int texNumC,
    int texelsInBatch, int texelsInLogicalRow, int b,
    int row, int col) {
  int index = b * texelsInBatch + (row / 2) * texelsInLogicalRow + (col / 2);
  int texR = index / texNumC;
  int texC = index - texR * texNumC;
  return (vec2(texC, texR) + halfCR) / vec2(texNumC, texNumR);
}
`;

const SHADER_PACKED_PREFIX = `
  float getChannel(vec4 frag, vec2 innerDims) {
    vec2 modCoord = mod(innerDims, 2.);
    return modCoord.x == 0. ?
      (modCoord.y == 0. ? frag.r : frag.g) :
      (modCoord.y == 0. ? frag.b : frag.a);
  }
  float getChannel(vec4 frag, int dim) {
    float modCoord = mod(float(dim), 2.);
    return modCoord == 0. ? frag.r : frag.g;
  }
`;

function getOutputScalarCoords() {
  return `
    int getOutputCoords() {
      return 0;
    }
  `;
}

function getOutputPacked1DCoords(
    shape: [number], texShape: [number, number]): string {
  const outputPackedTexShape =
      [Math.ceil(texShape[0] / 2), Math.ceil(texShape[1] / 2)];

  if (outputPackedTexShape[0] === 1) {
    return `
      int getOutputCoords() {
        return 2 * int(resultUV.x * float(outputPackedTexShape[1]));
      }
    `;
  }

  if (outputPackedTexShape[1] === 1) {
    return `
      int getOutputCoords() {
        return 2 * int(resultUV.y * float(outputPackedTexShape[0]));
      }
    `;
  }

  return `
    int getOutputCoords() {
      int packedTexShapeR = outputPackedTexShape[0];
      int packedTexShapeC = outputPackedTexShape[1];
      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(packedTexShapeR, packedTexShapeC));
      return resTexRC.x * packedTexShapeC + resTexRC.y;
    }
  `;
}

function getOutput1DCoords(
    shape: [number], texShape: [number, number]): string {
  if (texShape[0] === 1) {
    return `
      int getOutputCoords() {
        return int(resultUV.x * float(outputTexShape[1]));
      }
    `;
  }
  if (texShape[1] === 1) {
    return `
      int getOutputCoords() {
        return int(resultUV.y * float(outputTexShape[0]));
      }
    `;
  }
  return `
    int getOutputCoords() {
      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(outputTexShape[0], outputTexShape[1]));
      return resTexRC.x * outputTexShape[1] + resTexRC.y;
    }
  `;
}

function getOutputPacked3DCoords(
    shape: [number, number, number], texShape: [number, number]): string {
  return `
    ivec3 getOutputCoords() {
      int packedTexShapeR = outputPackedTexShape[0];
      int packedTexShapeC = outputPackedTexShape[1];

      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(packedTexShapeR, packedTexShapeC));
      int index = resTexRC.x * packedTexShapeC + resTexRC.y;

      int b = index / outputTexelsInBatch;
      index -= b * outputTexelsInBatch;

      int r = 2 * (index / outputTexelsInLogicalRow);
      int c = imod(index, outputTexelsInLogicalRow) * 2;

      return ivec3(b, r, c);
    }
  `;
}

function getOutput3DCoords(
    shape: [number, number, number], texShape: [number, number]): string {
  const coordsFromIndexSnippet = shader_util.getLogicalCoordinatesFromFlatIndex(
      ['r', 'c', 'd'], shape, 'index', 'outputStrides');
  return `
    ivec3 getOutputCoords() {
      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(outputTexShape[0], outputTexShape[1]));
      int index = resTexRC.x * outputTexShape[1] + resTexRC.y;
      ${coordsFromIndexSnippet}
      return ivec3(r, c, d);
    }
  `;
}

function getOutputPackedNDCoords(
    shape: number[], texShape: [number, number]): string {
  const texelsInLogicalRow = Math.ceil(shape[shape.length - 1] / 2);
  const texelsInBatch =
      texelsInLogicalRow * Math.ceil(shape[shape.length - 2] / 2);
  let texelsInBatchN = texelsInBatch;
  let batches = ``;
  let coords = 'b, r, c';

  const rank = shape.length;
  for (let b = 2; b < rank - 1; b++) {
    texelsInBatchN *= shape[rank - b - 1];
    batches = `
      int b${b} = index / ${texelsInBatchN};
      index -= b${b} * ${texelsInBatchN};
    ` + batches;
    coords = `b${b}, ` + coords;
  }

  return `
    ivec${shape.length} getOutputCoords() {
      int packedTexShapeR = outputPackedTexShape[0];
      int packedTexShapeC = outputPackedTexShape[1];

      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(packedTexShapeR, packedTexShapeC));
      int index = resTexRC.x * packedTexShapeC + resTexRC.y;

      ${batches}

      int b = index / outputTexelsInBatch;
      index -= b * outputTexelsInBatch;

      int r = 2 * (index / outputTexelsInLogicalRow);
      int c = imod(index, outputTexelsInLogicalRow) * 2;

      return ivec${rank}(${coords});
    }
  `;
}

function getOutput4DCoords(
    shape: [number, number, number, number],
    texShape: [number, number]): string {
  const coordsFromIndexSnippet = shader_util.getLogicalCoordinatesFromFlatIndex(
      ['r', 'c', 'd', 'd2'], shape, 'index', 'outputStrides');

  return `
    ivec4 getOutputCoords() {
      ivec2 resTexRC = ivec2(resultUV.yx *
        vec2(outputTexShape[0], outputTexShape[1]));
      int index = resTexRC.x * outputTexShape[1] + resTexRC.y;
      ${coordsFromIndexSnippet}
      return ivec4(r, c, d, d2);
    }
  `;
}

function getOutput5DCoords(
    shape: [number, number, number, number, number],
    texShape: [number, number]): string {
  const coordsFromIndexSnippet = shader_util.getLogicalCoordinatesFromFlatIndex(
      ['r', 'c', 'd', 'd2', 'd3'], shape, 'index', 'outputStrides');

  return `
    ivec5 getOutputCoords() {
      ivec2 resTexRC = ivec2(resultUV.yx * vec2(outputTexShape[0],
                             outputTexShape[1]));

      int index = resTexRC.x * outputTexShape[1] + resTexRC.y;

      ${coordsFromIndexSnippet}

      ivec5 outShape = ivec5(r, c, d, d2, d3);
      return outShape;
    }
  `;
}

function getOutput6DCoords(
    shape: [number, number, number, number, number, number],
    texShape: [number, number]): string {
  const coordsFromIndexSnippet = shader_util.getLogicalCoordinatesFromFlatIndex(
      ['r', 'c', 'd', 'd2', 'd3', 'd4'], shape, 'index', 'outputStrides');

  return `
    ivec6 getOutputCoords() {
      ivec2 resTexRC = ivec2(resultUV.yx *
        vec2(outputTexShape[0], outputTexShape[1]));
      int index = resTexRC.x * outputTexShape[1] + resTexRC.y;

      ${coordsFromIndexSnippet}

      ivec6 result = ivec6(r, c, d, d2, d3, d4);
      return result;
    }
  `;
}

function getOutputPacked2DCoords(
    shape: [number, number], texShape: [number, number]): string {
  if (util.arraysEqual(shape, texShape)) {
    return `
      ivec2 getOutputCoords() {
        int packedTexShapeR = outputPackedTexShape[0];
        int packedTexShapeC = outputPackedTexShape[1];

        return 2 * ivec2(resultUV.yx * vec2(packedTexShapeR, packedTexShapeC));
      }
    `;
  }

  /**
   * getOutputCoords
   *
   * resTexRC: The rows and columns of the texels. If you move over one
   * texel to the right in the packed texture, you are moving over one column
   * (not two).
   *
   * index: The texel index
   */
  return `
    ivec2 getOutputCoords() {
      int packedTexShapeR = outputPackedTexShape[0];
      int packedTexShapeC = outputPackedTexShape[1];
      int texelsInLogicalRow = int(ceil(float(outputShape[1]) * 0.5));

      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(packedTexShapeR, packedTexShapeC));

      int index = resTexRC.x * packedTexShapeC + resTexRC.y;
      int r = 2 * (index / texelsInLogicalRow);
      int c = imod(index, texelsInLogicalRow) * 2;

      return ivec2(r, c);
    }
  `;
}

function getOutput2DCoords(
    shape: [number, number], texShape: [number, number]): string {
  if (util.arraysEqual(shape, texShape)) {
    return `
      ivec2 getOutputCoords() {
        return ivec2(resultUV.yx * vec2(outputTexShape[0],
        outputTexShape[1]));
      }
    `;
  }
  if (shape[1] === 1) {
    return `
      ivec2 getOutputCoords() {
        ivec2 resTexRC = ivec2(resultUV.yx *
                               vec2(outputTexShape[0], outputTexShape[1]));
        int index = resTexRC.x * outputTexShape[1] + resTexRC.y;
        return ivec2(index, 0);
      }
    `;
  }
  if (shape[0] === 1) {
    return `
      ivec2 getOutputCoords() {
        ivec2 resTexRC = ivec2(resultUV.yx *
                               vec2(outputTexShape[0], outputTexShape[1]));
        int index = resTexRC.x * outputTexShape[1] + resTexRC.y;
        return ivec2(0, index);
      }
    `;
  }
  return `
    ivec2 getOutputCoords() {
      ivec2 resTexRC = ivec2(resultUV.yx *
                             vec2(outputTexShape[0], outputTexShape[1]));
      int index = resTexRC.x * outputTexShape[1] + resTexRC.y;
      int r = index / outputShape[1];
      int c = index - r * outputShape[1];
      return ivec2(r, c);
    }
  `;
}

function getFlatOffsetUniformName(texName: string): string {
  return `offset${texName}`;
}

function getPackedSamplerScalar(inputInfo: InputInfo): string {
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const glsl = getGlslDifferences();
  return `
    vec4 ${funcName}() {
      return ${glsl.texture2D}(${texName}, halfCR);
    }
  `;
}

function getSamplerScalar(inputInfo: InputInfo): string {
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  if (inputInfo.shapeInfo.isUniform) {
    return `float ${funcName}() {return ${texName};}`;
  }
  const [texNumR, texNumC] = inputInfo.shapeInfo.texShape;
  if (texNumR === 1 && texNumC === 1) {
    return `
      float ${funcName}() {
        return sampleTexture(${texName}, halfCR);
      }
    `;
  }

  const texShapeUniform = `texShape${texName}`;
  const offset = getFlatOffsetUniformName(texName);
  return `
    float ${funcName}() {
      vec2 uv = uvFromFlat(${texShapeUniform}[0], ${texShapeUniform}[1], ${
      offset});
      return sampleTexture(${texName}, uv);
    }
  `;
}

function getPackedSampler1D(inputInfo: InputInfo): string {
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const glsl = getGlslDifferences();

  const packedTexShapeUniform = `packedTexShape${texName}`;
  return `
    vec4 ${funcName}(int index) {
      vec2 uv = packedUVfrom1D(
        ${packedTexShapeUniform}[0], ${packedTexShapeUniform}[1], index);
      return ${glsl.texture2D}(${texName}, uv);
    }
  `;
}

function getSampler1D(inputInfo: InputInfo): string {
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  if (inputInfo.shapeInfo.isUniform) {
    // Uniform arrays will be less than 65505 (no risk of float16 overflow).
    return `
      float ${funcName}(int index) {
        ${getUniformSampler(inputInfo)}
      }
    `;
  }

  const texShape = inputInfo.shapeInfo.texShape;
  const tNumR = texShape[0];
  const tNumC = texShape[1];
  const texShapeUniform = `texShape${texName}`;

  if (tNumC === 1 && tNumR === 1) {
    return `
      float ${funcName}(int index) {
        return sampleTexture(${texName}, halfCR);
      }
    `;
  }
  const offset = getFlatOffsetUniformName(texName);
  if (tNumC === 1) {
    return `
      float ${funcName}(int index) {
        vec2 uv = vec2(0.5, (float(index + ${offset}) + 0.5) /
          float(${texShapeUniform}[0]));
        return sampleTexture(${texName}, uv);
      }
    `;
  }
  if (tNumR === 1) {
    return `
      float ${funcName}(int index) {
        vec2 uv = vec2((float(index + ${offset}) + 0.5) /
          float(${texShapeUniform}[1]), 0.5);
        return sampleTexture(${texName}, uv);
      }
    `;
  }
  return `
    float ${funcName}(int index) {
      vec2 uv = uvFromFlat(
        ${texShapeUniform}[0],
        ${texShapeUniform}[1],
        index + ${offset});
      return sampleTexture(${texName}, uv);
    }
  `;
}

function getPackedSampler2D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const texShape = inputInfo.shapeInfo.texShape;

  const texShapeUniform = `texShape${texName}`;
  const glsl = getGlslDifferences();
  if (texShape != null && util.arraysEqual(shape, texShape)) {
    return `
      vec4 ${funcName}(int row, int col) {
        vec2 uv = (vec2(col, row) + halfCR) / vec2(
          float(${texShapeUniform}[1]),
          float(${texShapeUniform}[0]));

        return ${glsl.texture2D}(${texName}, uv);
      }
    `;
  }

  const packedTexShapeUniform = `packedTexShape${texName}`;
  const valuesPerRowUniform = `valuesPerRow${texName}`;
  return `
    vec4 ${funcName}(int row, int col) {
      int valuesPerRow = ${valuesPerRowUniform};

      vec2 uv = packedUVfrom2D(valuesPerRow,
        ${packedTexShapeUniform}[0], ${packedTexShapeUniform}[1], row, col);
      return ${glsl.texture2D}(${texName}, uv);
    }
  `;
}

function getSampler2D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const texShape = inputInfo.shapeInfo.texShape;

  if (texShape != null && util.arraysEqual(shape, texShape)) {
    const texShapeUniform = `texShape${texName}`;
    return `
        float ${funcName}(int row, int col) {
          vec2 uv = (vec2(col, row) + halfCR) / vec2(
              float(${texShapeUniform}[1]),
              float(${texShapeUniform}[0])
            );
          return sampleTexture(${texName}, uv);
        }
      `;
  }

  const {newShape, keptDims} = util.squeezeShape(shape);
  const squeezedShape = newShape;
  if (squeezedShape.length < shape.length) {
    const newInputInfo = squeezeInputInfo(inputInfo, squeezedShape);
    const params = ['row', 'col'];
    return `
      ${getSamplerFromInInfo(newInputInfo)}
      float ${funcName}(int row, int col) {
        return ${funcName}(${getSqueezedParams(params, keptDims)});
      }
    `;
  }

  const shapeUniform = `shape${texName}`;
  if (inputInfo.shapeInfo.isUniform) {
    // Uniform arrays will be less than 65505 (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col) {
        int index = round(dot(vec2(row, col), vec2(${shapeUniform}[1], 1)));
        ${getUniformSampler(inputInfo)}
      }
    `;
  }

  const texNumR = texShape[0];
  const texNumC = texShape[1];
  const texShapeUniform = `texShape${texName}`;
  const offset = getFlatOffsetUniformName(texName);
  if (texNumC === 1) {
    // index is used directly as physical (no risk of float16 overflow).
    return `
    float ${funcName}(int row, int col) {
      float index = dot(vec3(row, col, ${offset}),
        vec3(${shapeUniform}[1], 1, 1));
      vec2 uv = vec2(0.5, (index + 0.5) / float(${texShapeUniform}[0]));
      return sampleTexture(${texName}, uv);
    }
  `;
  }
  if (texNumR === 1) {
    // index is used directly as physical (no risk of float16 overflow).
    return `
    float ${funcName}(int row, int col) {
      float index = dot(vec3(row, col, ${offset}),
        vec3(${shapeUniform}[1], 1, 1));
      vec2 uv = vec2((index + 0.5) / float(${texShapeUniform}[1]), 0.5);
      return sampleTexture(${texName}, uv);
    }
  `;
  }

  return `
  float ${funcName}(int row, int col) {
    // Explicitly use integer operations as dot() only works on floats.
    int index = row * ${shapeUniform}[1] + col + ${offset};
    vec2 uv = uvFromFlat(${texShapeUniform}[0],
        ${texShapeUniform}[1], index);
    return sampleTexture(${texName}, uv);
  }
`;
}

function getPackedSampler3D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);

  if (shape[0] === 1) {
    const squeezedShape = util.packedShapeTransform(shape);
    const keptDims = [1, 2];
    const newInputInfo = squeezeInputInfo(inputInfo, squeezedShape);
    const params = ['b', 'row', 'col'];
    return `
        ${getPackedSamplerFromInInfo(newInputInfo)}
        vec4 ${funcName}(int b, int row, int col) {
          return ${funcName}(${getSqueezedParams(params, keptDims)});
        }
      `;
  }

  const packedTexShapeUniform = `packedTexShape${texName}`;
  const valuesPerRowUniform = `valuesPerRow${texName}`;
  const texelsInBatchUniform = `texelsInBatch${texName}`;
  const glsl = getGlslDifferences();

  return `
    vec4 ${funcName}(int b, int row, int col) {
      int valuesPerRow = ${valuesPerRowUniform};
      int texelsInBatch = ${texelsInBatchUniform};

      vec2 uv = packedUVfrom3D(
        ${packedTexShapeUniform}[0], ${packedTexShapeUniform}[1], texelsInBatch,
        valuesPerRow, b, row, col);
      return ${glsl.texture2D}(${texName}, uv);
    }
  `;
}

function getSampler3D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const shapeUniform = `shape${texName}`;

  const stride0 = shape[1] * shape[2];
  const stride1 = shape[2];

  const strideUniform = `strides${texName}`;

  const {newShape, keptDims} = util.squeezeShape(shape);
  const squeezedShape = newShape;
  if (squeezedShape.length < shape.length) {
    const newInputInfo = squeezeInputInfo(inputInfo, squeezedShape);
    const params = ['row', 'col', 'depth'];
    return `
        ${getSamplerFromInInfo(newInputInfo)}
        float ${funcName}(int row, int col, int depth) {
          return ${funcName}(${getSqueezedParams(params, keptDims)});
        }
      `;
  }

  if (inputInfo.shapeInfo.isUniform) {
    // Uniform arrays will be less than 65505 (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth) {
        int index = round(dot(vec3(row, col, depth),
                          vec3(${strideUniform}[0], ${strideUniform}[1], 1)));
        ${getUniformSampler(inputInfo)}
      }
    `;
  }

  const texShape = inputInfo.shapeInfo.texShape;
  const texNumC = texShape[1];
  const texShapeUniform = `texShape${texName}`;
  const flatOffset = inputInfo.shapeInfo.flatOffset;
  if (texNumC === stride0 && flatOffset == null) {
    // texC is used directly as physical (no risk of float16 overflow).
    return `
        float ${funcName}(int row, int col, int depth) {
          float texR = float(row);
          float texC = dot(vec2(col, depth), vec2(${strideUniform}[1], 1));
          vec2 uv = (vec2(texC, texR) + halfCR) /
                     vec2(float(${texShapeUniform}[1]),
                      float(${texShapeUniform}[0]));
          return sampleTexture(${texName}, uv);
        }
      `;
  }

  if (texNumC === stride1 && flatOffset == null) {
    // texR is used directly as physical (no risk of float16 overflow).
    return `
    float ${funcName}(int row, int col, int depth) {
      float texR = dot(vec2(row, col), vec2(${shapeUniform}[1], 1));
      float texC = float(depth);
      vec2 uv = (vec2(texC, texR) + halfCR) /
        vec2(float(${texShapeUniform}[1]), float(${texShapeUniform}[0]));
      return sampleTexture(${texName}, uv);
    }
  `;
  }

  const offset = getFlatOffsetUniformName(texName);
  return `
      float ${funcName}(int row, int col, int depth) {
        // Explicitly use integer operations as dot() only works on floats.
        int index = row * ${strideUniform}[0] + col * ${strideUniform}[1] + 
           depth + ${offset};
        vec2 uv = uvFromFlat(${texShapeUniform}[0],
          ${texShapeUniform}[1], index);
        return sampleTexture(${texName}, uv);
      }
  `;
}

function getPackedSamplerND(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const rank = shape.length;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);

  const valuesPerRow = Math.ceil(shape[rank - 1] / 2);
  let texelsInBatch = valuesPerRow * Math.ceil(shape[rank - 2] / 2);
  let params = `int b, int row, int col`;
  let index = `b * ${texelsInBatch} + (row / 2) * ${valuesPerRow} + (col / 2)`;
  for (let b = 2; b < rank - 1; b++) {
    params = `int b${b}, ` + params;
    texelsInBatch *= shape[rank - b - 1];
    index = `b${b} * ${texelsInBatch} + ` + index;
  }
  const glsl = getGlslDifferences();
  const packedTexShapeUniform = `packedTexShape${texName}`;
  return `
    vec4 ${funcName}(${params}) {
      int index = ${index};
      int packedTexShapeR = ${packedTexShapeUniform}[0];
      int packedTexShapeC = ${packedTexShapeUniform}[1];

      int texR = index / packedTexShapeC;
      int texC = index - texR * packedTexShapeC;
      vec2 uv = (vec2(texC, texR) + halfCR) /
        vec2(packedTexShapeC, packedTexShapeR);
      return ${glsl.texture2D}(${texName}, uv);
    }
  `;
}

function getSampler4D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const shapeUniform = `shape${texName}`;
  const stride2 = shape[3];
  const stride1 = shape[2] * stride2;
  const stride0 = shape[1] * stride1;

  const strideUniform = `strides${texName}`;

  const {newShape, keptDims} = util.squeezeShape(shape);
  if (newShape.length < shape.length) {
    const newInputInfo = squeezeInputInfo(inputInfo, newShape);
    const params = ['row', 'col', 'depth', 'depth2'];
    return `
      ${getSamplerFromInInfo(newInputInfo)}
      float ${funcName}(int row, int col, int depth, int depth2) {
        return ${funcName}(${getSqueezedParams(params, keptDims)});
      }
    `;
  }

  if (inputInfo.shapeInfo.isUniform) {
    // Uniform arrays will be less than 65505 (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth, int depth2) {
        int index = round(dot(vec4(row, col, depth, depth2),
                          vec4(${strideUniform}[0], ${strideUniform}[0], 
                               ${strideUniform}[2], 1)));
        ${getUniformSampler(inputInfo)}
      }
    `;
  }

  const flatOffset = inputInfo.shapeInfo.flatOffset;
  const texShape = inputInfo.shapeInfo.texShape;
  // const texNumR = texShape[0];
  const texNumC = texShape[1];
  const texShapeUniform = `texShape${texName}`;

  if (texNumC === stride0 && flatOffset == null) {
    // texC is used directly as physical (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth, int depth2) {
        float texR = float(row);
        float texC =
            dot(vec3(col, depth, depth2),
                vec3(${strideUniform}[1], ${strideUniform}[2], 1));
        vec2 uv = (vec2(texC, texR) + halfCR) /
                   vec2(float(${texShapeUniform}[1]),
                    float(${texShapeUniform}[0]));
        return sampleTexture(${texName}, uv);
      }
    `;
  }
  if (texNumC === stride2 && flatOffset == null) {
    // texR is used directly as physical (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth, int depth2) {
        float texR = dot(vec3(row, col, depth),
                         vec3(
                           ${shapeUniform}[1] * ${shapeUniform}[2],
                           ${shapeUniform}[2], 1));
        float texC = float(depth2);
        vec2 uv = (vec2(texC, texR) + halfCR) /
                  vec2(float(${texShapeUniform}[1]), float(${
        texShapeUniform}[0]));
        return sampleTexture(${texName}, uv);
      }
    `;
  }

  const offset = getFlatOffsetUniformName(texName);
  return `
    float ${funcName}(int row, int col, int depth, int depth2) {
      // Explicitly use integer operations as dot() only works on floats.
      int index = row * ${strideUniform}[0] + col * ${strideUniform}[1] +
          depth * ${strideUniform}[2] + depth2;
      vec2 uv = uvFromFlat(
        ${texShapeUniform}[0],
        ${texShapeUniform}[1],
        index + ${offset});
      return sampleTexture(${texName}, uv);
    }
  `;
}

function getSampler5D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);
  const stride3 = shape[4];
  const stride2 = shape[3] * stride3;
  const stride1 = shape[2] * stride2;
  const stride0 = shape[1] * stride1;

  const shapeUniform = `shape${texName}`;
  const strideUniform = `strides${texName}`;

  const {newShape, keptDims} = util.squeezeShape(shape);
  if (newShape.length < shape.length) {
    const newInputInfo = squeezeInputInfo(inputInfo, newShape);
    const params = ['row', 'col', 'depth', 'depth2', 'depth3'];
    return `
      ${getSamplerFromInInfo(newInputInfo)}
      float ${funcName}(int row, int col, int depth, int depth2, int depth3) {
        return ${funcName}(${getSqueezedParams(params, keptDims)});
      }
    `;
  }

  if (inputInfo.shapeInfo.isUniform) {
    // Uniform arrays will be less than 65505 (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth, int depth2, int depth3) {
        float index = dot(
          vec4(row, col, depth, depth2),
          vec4(${strideUniform}[0], ${strideUniform}[1], ${strideUniform}[2], 
               ${strideUniform}[3])) + depth3;
        ${getUniformSampler(inputInfo)}
      }
    `;
  }

  const flatOffset = inputInfo.shapeInfo.flatOffset;
  const texShape = inputInfo.shapeInfo.texShape;
  // const texNumR = texShape[0];
  const texNumC = texShape[1];

  const texShapeUniform = `texShape${texName}`;

  if (texNumC === stride0 && flatOffset == null) {
    // texC is used directly as physical (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth, int depth2, int depth3) {
        int texR = row;
        float texC = dot(vec4(col, depth, depth2, depth3),
                         vec4(${strideUniform}[1], ${strideUniform}[2],
                            ${strideUniform}[3], 1));
        vec2 uv = (vec2(texC, texR) + halfCR) /
                   vec2(float(${texShapeUniform}[1]),
                    float(${texShapeUniform}[0]));
        return sampleTexture(${texName}, uv);
      }
    `;
  }

  if (texNumC === stride3 && flatOffset == null) {
    // texR is used directly as physical (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth, int depth2, int depth3) {
        float texR = dot(
          vec4(row, col, depth, depth2),
          vec4(${shapeUniform}[1] * ${shapeUniform}[2] * ${shapeUniform}[3]},
               ${shapeUniform}[2] * ${shapeUniform}[3], ${shapeUniform}[3], 1));
        int texC = depth3;
        vec2 uv = (vec2(texC, texR) + halfCR) /
                  vec2(float(${texShapeUniform}[1]),
                    float(${texShapeUniform}[0]));
        return sampleTexture(${texName}, uv);
      }
    `;
  }

  const offset = getFlatOffsetUniformName(texName);
  return `
    float ${funcName}(int row, int col, int depth, int depth2, int depth3) {
      // Explicitly use integer operations as dot() only works on floats.
      int index = row * ${strideUniform}[0] + col * ${
      strideUniform}[1] + depth * ${strideUniform}[2] + depth2 * ${
      strideUniform}[3] + depth3 + ${offset};
      vec2 uv = uvFromFlat(${texShapeUniform}[0], ${texShapeUniform}[1], index);
      return sampleTexture(${texName}, uv);
    }
  `;
}

function getSampler6D(inputInfo: InputInfo): string {
  const shape = inputInfo.shapeInfo.logicalShape;
  const texName = inputInfo.name;
  const funcName = 'get' + texName.charAt(0).toUpperCase() + texName.slice(1);

  const {newShape, keptDims} = util.squeezeShape(shape);
  if (newShape.length < shape.length) {
    const newInputInfo = squeezeInputInfo(inputInfo, newShape);
    const params = ['row', 'col', 'depth', 'depth2', 'depth3', 'depth4'];
    return `
      ${getSamplerFromInInfo(newInputInfo)}
      float ${funcName}(int row, int col, int depth,
                    int depth2, int depth3, int depth4) {
        return ${funcName}(${getSqueezedParams(params, keptDims)});
      }
    `;
  }

  const stride4 = shape[5];
  const stride3 = shape[4] * stride4;
  const stride2 = shape[3] * stride3;
  const stride1 = shape[2] * stride2;
  const stride0 = shape[1] * stride1;

  const shapeUniform = `shape${texName}`;
  const strideUniform = `strides${texName}`;

  if (inputInfo.shapeInfo.isUniform) {
    // Uniform arrays will be less than 65505 (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth,
                  int depth2, int depth3, int depth4) {
        int index = round(dot(
          vec4(row, col, depth, depth2),
          vec4(${strideUniform}[0], ${strideUniform}[1], ${strideUniform}[2], ${
        strideUniform}[3])) +
          dot(
            vec2(depth3, depth4),
            vec2(${strideUniform}[4], 1)));
        ${getUniformSampler(inputInfo)}
      }
    `;
  }

  const flatOffset = inputInfo.shapeInfo.flatOffset;
  const texShape = inputInfo.shapeInfo.texShape;
  const texNumR = texShape[0];
  const texNumC = texShape[1];
  const texShapeUniform = `texShape${texName}`;
  if (texNumC === stride0 && flatOffset == null) {
    // texC is used directly as physical (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth,
                    int depth2, int depth3, int depth4) {
        int texR = row;
        float texC = dot(
          vec4(col, depth, depth2, depth3),
          vec4(${strideUniform}[1], ${strideUniform}[2], ${strideUniform}[3], 
            ${strideUniform}[4]))
             + float(depth4);
        vec2 uv = (vec2(texC, texR) + halfCR) /
                   vec2(float(${texShapeUniform}[1]),
                    float(${texShapeUniform}[0]));
        return sampleTexture(${texName}, uv);
      }
    `;
  }
  if (texNumC === stride4 && flatOffset == null) {
    // texR is used directly as physical (no risk of float16 overflow).
    return `
      float ${funcName}(int row, int col, int depth,
                    int depth2, int depth3, int depth4) {
        float texR = dot(vec4(row, col, depth, depth2),
          vec4(${shapeUniform}[1] * ${shapeUniform}[2] * ${shapeUniform}[3]
            * ${shapeUniform}[4]},
               ${shapeUniform}[2] * ${shapeUniform}[3] * ${shapeUniform}[4],
               ${shapeUniform}[3] * ${shapeUniform}[4],
               ${shapeUniform}[4])) + float(depth3);
        int texC = depth4;
        vec2 uv = (vec2(texC, texR) + halfCR) /
                  vec2(${texNumC}.0, ${texNumR}.0);
        return sampleTexture(${texName}, uv);
      }
    `;
  }
  const offset = getFlatOffsetUniformName(texName);
  return `
    float ${funcName}(int row, int col, int depth,
                  int depth2, int depth3, int depth4) {
      // Explicitly use integer operations as dot() only works on floats.
      int index = row * ${strideUniform}[0] + col * ${
      strideUniform}[1] + depth * ${strideUniform}[2] + depth2 * ${
      strideUniform}[3] + depth3 * ${strideUniform}[4] +
      depth4 + ${offset};
      vec2 uv = uvFromFlat(${texShapeUniform}[0], ${texShapeUniform}[1], index);
      return sampleTexture(${texName}, uv);
    }
  `;
}

function getUniformSampler(inputInfo: InputInfo): string {
  const texName = inputInfo.name;
  const inSize = util.sizeFromShape(inputInfo.shapeInfo.logicalShape);

  if (inSize < 2) {
    return `return ${texName};`;
  }

  return `
    for (int i = 0; i < (${inSize}); i++) {
      if (i == index) {
        return ${texName}[i];
      }
    }
  `;
}

function getPackedSamplerAtOutputCoords(
    inputInfo: InputInfo, outShapeInfo: ShapeInfo) {
  const texName = inputInfo.name;
  const texFuncSnippet = texName.charAt(0).toUpperCase() + texName.slice(1);
  const funcName = 'get' + texFuncSnippet + 'AtOutCoords';
  const inRank = inputInfo.shapeInfo.logicalShape.length;
  const outRank = outShapeInfo.logicalShape.length;

  const broadcastDims = getBroadcastDims(
      inputInfo.shapeInfo.logicalShape, outShapeInfo.logicalShape);

  const type = getCoordsDataType(outRank);
  const rankDiff = outRank - inRank;
  let coordsSnippet: string;
  const fields = ['x', 'y', 'z', 'w', 'u', 'v'];

  if (inRank === 0) {
    coordsSnippet = '';
  } else if (outRank < 2 && broadcastDims.length >= 1) {
    coordsSnippet = 'coords = 0;';
  } else {
    coordsSnippet =
        broadcastDims.map(d => `coords.${fields[d + rankDiff]} = 0;`)
            .join('\n');
  }
  let unpackedCoordsSnippet = '';
  if (outRank < 2 && inRank > 0) {
    unpackedCoordsSnippet = 'coords';
  } else {
    unpackedCoordsSnippet = inputInfo.shapeInfo.logicalShape
                                .map((s, i) => `coords.${fields[i + rankDiff]}`)
                                .join(', ');
  }

  let output = `return outputValue;`;
  const inSize = util.sizeFromShape(inputInfo.shapeInfo.logicalShape);
  const isInputScalar = inSize === 1;
  const outSize = util.sizeFromShape(outShapeInfo.logicalShape);
  const isOutputScalar = outSize === 1;

  if (inRank === 1 && !isInputScalar && !isOutputScalar) {
    output = `
      return vec4(outputValue.xy, outputValue.xy);
    `;
  } else if (isInputScalar && !isOutputScalar) {
    if (outRank === 1) {
      output = `
        return vec4(outputValue.x, outputValue.x, 0., 0.);
      `;
    } else {
      output = `
        return vec4(outputValue.x);
      `;
    }
  } else if (broadcastDims.length) {
    const rows = inRank - 2;
    const cols = inRank - 1;

    if (broadcastDims.indexOf(rows) > -1 && broadcastDims.indexOf(cols) > -1) {
      output = `return vec4(outputValue.x);`;
    } else if (broadcastDims.indexOf(rows) > -1) {
      output = `return vec4(outputValue.x, outputValue.y, ` +
          `outputValue.x, outputValue.y);`;
    } else if (broadcastDims.indexOf(cols) > -1) {
      output = `return vec4(outputValue.xx, outputValue.zz);`;
    }
  }

  return `
    vec4 ${funcName}() {
      ${type} coords = getOutputCoords();
      ${coordsSnippet}
      vec4 outputValue = get${texFuncSnippet}(${unpackedCoordsSnippet});
      ${output}
    }
  `;
}

function getSamplerAtOutputCoords(
    inputInfo: InputInfo, outShapeInfo: ShapeInfo) {
  const texName = inputInfo.name;
  const texFuncSnippet = texName.charAt(0).toUpperCase() + texName.slice(1);
  const funcName = 'get' + texFuncSnippet + 'AtOutCoords';
  const outTexShape = outShapeInfo.texShape;
  const inTexShape = inputInfo.shapeInfo.texShape;
  const inRank = inputInfo.shapeInfo.logicalShape.length;
  const outRank = outShapeInfo.logicalShape.length;

  if (!inputInfo.shapeInfo.isUniform && inRank === outRank &&
      inputInfo.shapeInfo.flatOffset == null &&
      util.arraysEqual(inTexShape, outTexShape)) {
    return `
      float ${funcName}() {
        return sampleTexture(${texName}, resultUV);
      }
    `;
  }

  const type = getCoordsDataType(outRank);
  const broadcastDims = getBroadcastDims(
      inputInfo.shapeInfo.logicalShape, outShapeInfo.logicalShape);
  const rankDiff = outRank - inRank;
  let coordsSnippet: string;
  const fields = ['x', 'y', 'z', 'w', 'u', 'v'];

  if (inRank === 0) {
    coordsSnippet = '';
  } else if (outRank < 2 && broadcastDims.length >= 1) {
    coordsSnippet = 'coords = 0;';
  } else {
    coordsSnippet =
        broadcastDims.map(d => `coords.${fields[d + rankDiff]} = 0;`)
            .join('\n');
  }
  let unpackedCoordsSnippet = '';
  if (outRank < 2 && inRank > 0) {
    unpackedCoordsSnippet = 'coords';
  } else {
    unpackedCoordsSnippet = inputInfo.shapeInfo.logicalShape
                                .map((s, i) => `coords.${fields[i + rankDiff]}`)
                                .join(', ');
  }

  return `
    float ${funcName}() {
      ${type} coords = getOutputCoords();
      ${coordsSnippet}
      return get${texFuncSnippet}(${unpackedCoordsSnippet});
    }
  `;
}

export function getCoordsDataType(rank: number): string {
  if (rank <= 1) {
    return 'int';
  } else if (rank === 2) {
    return 'ivec2';
  } else if (rank === 3) {
    return 'ivec3';
  } else if (rank === 4) {
    return 'ivec4';
  } else if (rank === 5) {
    return 'ivec5';
  } else if (rank === 6) {
    return 'ivec6';
  } else {
    throw Error(`GPU for rank ${rank} is not yet supported`);
  }
}

/** Returns a new input info (a copy) that has a squeezed logical shape. */
function squeezeInputInfo(
    inInfo: InputInfo, squeezedShape: number[]): InputInfo {
  // Deep copy.
  const newInputInfo: InputInfo = JSON.parse(JSON.stringify(inInfo));
  newInputInfo.shapeInfo.logicalShape = squeezedShape;
  return newInputInfo;
}

function getSqueezedParams(params: string[], keptDims: number[]): string {
  return keptDims.map(d => params[d]).join(', ');
}
