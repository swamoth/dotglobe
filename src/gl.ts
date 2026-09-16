/**
 * The small part of WebGL2 that dotglobe uses. No abstraction beyond what three passes share.
 */

/**
 * Start a shader compiling. This does not ask whether the compile worked, because that question
 * blocks the main thread until the driver answers. `ready` reports the error later.
 */
export function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/**
 * Link a program without waiting for the driver.
 *
 * Reading the link status blocks the main thread until the driver finishes. This shader needs
 * about 56 ms the first time, because ANGLE translates it and Direct3D compiles the result. Do
 * not ask here. Ask `ready` for each frame instead, so the page can fetch a land mask while the
 * driver works on another thread.
 */
export interface Program {
  handle: WebGLProgram;
  /**
   * True once the driver has linked the program. Throws when the link failed.
   *
   * Without the parallel extension the first call blocks, which is the old behavior. With it,
   * the call returns at once and the answer arrives on a later frame.
   */
  ready(): boolean;
  /** Every uniform of the program, by name. Empty until `ready` returns true. */
  uniforms: Record<string, WebGLUniformLocation>;
  destroy(): void;
}

/**
 * Link a program without waiting for the driver.
 *
 * Reading a compile or link status blocks the main thread until the driver finishes. This
 * shader needs about 56 ms the first time, because ANGLE translates it and the platform then
 * compiles the result. Ask nothing here. Ask `ready` for each frame instead, so the page can
 * fetch a land mask while the driver works on another thread.
 */
export function program(gl: WebGL2RenderingContext, vert: string, frag: string): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const handle = gl.createProgram()!;
  gl.attachShader(handle, vs);
  gl.attachShader(handle, fs);
  gl.linkProgram(handle);

  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  let linked = false;

  const self: Program = {
    handle,
    uniforms: {},
    ready() {
      if (linked) return true;
      if (parallel && !gl.getProgramParameter(handle, parallel.COMPLETION_STATUS_KHR)) return false;
      if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
        // Only now, on the failure path, is it worth blocking for the two shader logs.
        const logs = [gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs), gl.getProgramInfoLog(handle)];
        self.destroy();
        throw new Error(`dotglobe: program failed to link. ${logs.filter(Boolean).join(' ')}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      self.uniforms = uniforms(gl, handle);
      linked = true;
      return true;
    },
    destroy() {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(handle);
    },
  };
  return self;
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
