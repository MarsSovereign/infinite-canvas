/**
 * Call scripts for a self-hosted MiniMax-H3 Studio (https://github.com/MarsSovereign/minimax-h3-studio):
 * the canvas submits jobs to the Studio's own queue on a local GPU and polls them.
 * Kept as plain scripts so users can copy and adapt them like the other templates.
 */

export const H3_STUDIO_IMAGE_SCRIPT = `/**
 * MiniMax-H3 Studio (local GPU) pictures: one POST {baseUrl}/api/jobs (kind=image) per image, then poll each job.
 * baseUrl is the Studio address, e.g. http://gpu-host:8190. apiKey is the Studio's H3_API_TOKEN
 * (any text when the Studio runs without one). The Studio must list this page's origin in H3_CORS_ORIGINS.
 * model is a Studio image model: "qwen-image-21-turbo", "flux-klein-4b" or "moss" (generation only);
 * any other name uses qwen-image-21-turbo.
 * With images, the first four become ref_image inputs of an edit that keeps the first image's canvas.
 * @param {string} prompt
 * @param {string[]} images - data URLs; empty for text-to-image
 * @param {object} params
 * @param {string} params.size - "1024x1536", "16:9" or "auto"; snapped to 16:9, 9:16, 4:3, 3:4 or 1:1
 * @param {number} params.count - number of images (each is its own Studio job)
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<string[]>} image URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    count,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  const studio = baseUrl.replace(/\\/+$/, "");
  const headers = { Authorization: \`Bearer \${apiKey}\` };

  async function call(method, path, data) {
    try {
      return await request({ method, url: \`\${studio}\${path}\`, headers, data });
    } catch (error) {
      throw new Error(error?.response?.data?.error || error.message);
    }
  }

  function snapRatio(value) {
    const ratios = { "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "3:4": 3 / 4, "1:1": 1 };
    const match = String(value || "").match(/^(\\d+(?:\\.\\d+)?)\\s*[:x]\\s*(\\d+(?:\\.\\d+)?)$/);
    if (!match) return "1:1";
    const target = Number(match[1]) / Number(match[2]);
    let best = "1:1";
    for (const key of Object.keys(ratios)) {
      if (Math.abs(Math.log(ratios[key] / target)) < Math.abs(Math.log(ratios[best] / target))) best = key;
    }
    return best;
  }

  const imageModel = ["qwen-image-21-turbo", "flux-klein-4b", "moss"].includes(model) ? model : "qwen-image-21-turbo";
  const refs = await Promise.all(images.slice(0, 4).map(async (dataUrl) => (await fetch(dataUrl)).blob()));
  const jobs = [];
  for (let i = 0; i < Math.max(1, Number(count) || 1); i++) {
    const form = new FormData();
    form.set("kind", "image");
    form.set("image_model", imageModel);
    form.set("prompt", prompt);
    form.set("aspect_ratio", refs.length ? "image" : snapRatio(size));
    for (const blob of refs) form.append("ref_image", blob, "ref.png");
    jobs.push(await call("post", "/api/jobs", form));
  }

  const urls = [];
  for (const job of jobs) {
    const done = await poll(
      () => call("get", \`/api/jobs/\${job.id}\`),
      (state) => {
        if (state.status === "failed" || state.status === "canceled") {
          throw new Error(state.error ? state.error.split("\\n").filter(Boolean).pop() : \`Studio job \${state.status}\`);
        }
        return state.status === "done" && state.picture_url ? state : null;
      },
      { intervalMs: 2000, timeoutMs: 60 * 60 * 1000 },
    );
    urls.push(\`\${studio}\${done.picture_url}\`);
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`;

export const H3_STUDIO_VIDEO_SCRIPT = `/**
 * MiniMax-H3 Studio (local GPU): POST {baseUrl}/api/jobs as a form, then poll /api/jobs/{id}.
 * baseUrl is the Studio address, e.g. http://gpu-host:8190. apiKey is the Studio's H3_API_TOKEN
 * (any text when the Studio runs without one). The Studio must list this page's origin in H3_CORS_ORIGINS.
 * model is a Studio model choice from /api/presets "loras", e.g. "fasth3-omniref" or "larryvrh-v4-sparse";
 * "h3" lets the Studio pick its recommended choice for the mode and resolution.
 * Frames mode: no image = text to video, images[0] = first frame, images[1] = last frame.
 * Reference mode: images -> ref_image (up to 6), videos -> ref_video (up to 3, at least 2 s each).
 * audios[0], when present, is sent as guide audio in either mode.
 * @param {string} prompt
 * @param {string[]} images - data URLs
 * @param {File[]} videos
 * @param {File[]} audios
 * @param {object} params
 * @param {string} params.mode - "frames" or "reference"
 * @param {string|number} params.seconds - clamped to the Studio's 2-15 s
 * @param {string} params.resolution - "480p"/"544p" map to 544p, larger values to 768p
 * @param {string} params.ratio - snapped to 16:9, 9:16, 4:3, 3:4 or 1:1
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    resolution,
    ratio,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  const studio = baseUrl.replace(/\\/+$/, "");
  const headers = { Authorization: \`Bearer \${apiKey}\` };

  async function call(method, path, data) {
    try {
      return await request({ method, url: \`\${studio}\${path}\`, headers, data });
    } catch (error) {
      throw new Error(error?.response?.data?.error || error.message);
    }
  }

  function snapRatio(value) {
    const ratios = { "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "3:4": 3 / 4, "1:1": 1 };
    const match = String(value || "").match(/^(\\d+(?:\\.\\d+)?)\\s*[:x]\\s*(\\d+(?:\\.\\d+)?)$/);
    if (!match) return "16:9";
    const target = Number(match[1]) / Number(match[2]);
    let best = "16:9";
    for (const key of Object.keys(ratios)) {
      if (Math.abs(Math.log(ratios[key] / target)) < Math.abs(Math.log(ratios[best] / target))) best = key;
    }
    return best;
  }

  const toBlob = async (dataUrl) => (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.set("kind", "video");
  form.set("prompt", prompt);
  form.set("duration", String(Math.min(15, Math.max(2, Number(seconds) || 5))));
  form.set("resolution", (parseInt(resolution, 10) || 768) <= 600 ? "544p" : "768p");
  form.set("aspect_ratio", snapRatio(ratio));
  if (model && !["h3", "auto", "default"].includes(model)) form.set("lora", model);
  if (mode === "reference") {
    for (const dataUrl of images.slice(0, 6)) form.append("ref_image", await toBlob(dataUrl), "ref.png");
    for (const file of videos.slice(0, 3)) form.append("ref_video", file, file.name || "ref.mp4");
  } else if (images.length) {
    form.append("image", await toBlob(images[0]), "first.png");
    if (images[1]) form.append("last_image", await toBlob(images[1]), "last.png");
    form.set("aspect_ratio", "image");
  }
  if (audios[0]) form.append("audio", audios[0], audios[0].name || "guide.mp3");

  const job = await call("post", "/api/jobs", form);
  // One GPU runs the Studio queue in order, so allow for waiting behind other jobs.
  const done = await poll(
    () => call("get", \`/api/jobs/\${job.id}\`),
    (state) => {
      if (state.status === "failed" || state.status === "canceled") {
        throw new Error(state.error ? state.error.split("\\n").filter(Boolean).pop() : \`Studio job \${state.status}\`);
      }
      return state.status === "done" && state.video_url ? state : null;
    },
    { intervalMs: 3000, timeoutMs: 2 * 60 * 60 * 1000 },
  );
  return { url: \`\${studio}\${done.video_url}\` };
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`;

export const H3_STUDIO_AUDIO_SCRIPT = `/**
 * MiniMax-H3 Studio (local GPU) speech: POST {baseUrl}/api/jobs (kind=speech), then poll /api/jobs/{id}.
 * baseUrl is the Studio address, e.g. http://gpu-host:8190. apiKey is the Studio's H3_API_TOKEN
 * (any text when the Studio runs without one). The Studio must list this page's origin in H3_CORS_ORIGINS.
 * model is a Studio speech model: "qwen3_tts", "voxcpm2" or "omnivoice"; any other name uses qwen3_tts.
 * The canvas voices are OpenAI names the Studio does not have, so without instructions the model's
 * default voice speaks; with instructions the voice is designed from them (speech_mode=design).
 * The Studio returns WAV whatever params.format asks for.
 * @param {string} prompt - text to speak (at most 4000 characters)
 * @param {object} params
 * @param {string} params.instructions - voice description, e.g. "a warm elderly male narrator"
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}>}
 */
async function generateSpeech({
  prompt,
  params: {
    instructions,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  const studio = baseUrl.replace(/\\/+$/, "");
  const headers = { Authorization: \`Bearer \${apiKey}\` };

  async function call(method, path, data) {
    try {
      return await request({ method, url: \`\${studio}\${path}\`, headers, data });
    } catch (error) {
      throw new Error(error?.response?.data?.error || error.message);
    }
  }

  const form = new FormData();
  form.set("kind", "speech");
  form.set("audio_model", ["qwen3_tts", "voxcpm2", "omnivoice"].includes(model) ? model : "qwen3_tts");
  form.set("prompt", prompt);
  if (instructions && instructions.trim()) {
    form.set("speech_mode", "design");
    form.set("instruction", instructions.trim());
  }

  const job = await call("post", "/api/jobs", form);
  const done = await poll(
    () => call("get", \`/api/jobs/\${job.id}\`),
    (state) => {
      if (state.status === "failed" || state.status === "canceled") {
        throw new Error(state.error ? state.error.split("\\n").filter(Boolean).pop() : \`Studio job \${state.status}\`);
      }
      return state.status === "done" && state.audio_url ? state : null;
    },
    { intervalMs: 2000, timeoutMs: 60 * 60 * 1000 },
  );
  return { url: \`\${studio}\${done.audio_url}\` };
}

return await generateSpeech({
  prompt,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`;
