export function modelSupportsImages(model) {
  return Array.isArray(model?.input) && model.input.includes("image");
}
