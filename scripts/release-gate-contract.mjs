export const RELEASE_EMBEDDING_DIMENSIONS = 384;

export function assertReleaseEmbeddingVector(vector) {
  if (
    !Array.isArray(vector) ||
    vector.length !== RELEASE_EMBEDDING_DIMENSIONS ||
    !vector.every(Number.isFinite)
  ) {
    throw new Error(
      `real embedding probe must return exactly ${RELEASE_EMBEDDING_DIMENSIONS} finite values`,
    );
  }

  return vector;
}
