/**
 * The small part of WebGL2 that dotglobe uses. No abstraction beyond what three passes share.
 */

export function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`dotglobe: shader failed to compile. ${log}`);
  }
  return shader;
}

export function program(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`dotglobe: program failed to link. ${log}`);
  }
  return p;
}

/** Every uniform of a program, by name. One lookup at build time beats one for each frame. */
export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Record<string, WebGLUniformLocation> {
  const out: Record<string, WebGLUniformLocation> = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    if (!info) continue;
    const name = info.name.replace('[0]', '');
    const loc = gl.getUniformLocation(p, name);
    if (loc) out[name] = loc;
  }
  return out;
}

export interface TextureOptions {
  /** Internal format, for example gl.R8 or gl.RGBA8. */
  internal: number;
  format: number;
  type: number;
  /** Nearest keeps a mask crisp. Linear suits a color ramp. */
  filter?: number;
}

export function texture(gl: WebGL2RenderingContext, opts: TextureOptions): WebGLTexture {
  const tex = gl.createTexture()!;
  const filter = opts.filter ?? gl.NEAREST;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // longitude wraps
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Upload pixels to a texture. Row 0 of the data is the top row of the image. */
export function upload(
  gl: WebGL2RenderingContext, tex: WebGLTexture, opts: TextureOptions,
  data: ArrayBufferView | null, width: number, height: number,
) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, opts.internal, width, height, 0, opts.format, opts.type, data as ArrayBufferView);
}
