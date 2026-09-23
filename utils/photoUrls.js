function extractStoragePath(photoUrl, bucket) {
  if (!photoUrl) return null;

  const marker = `/storage/v1/object/public/${bucket}/`;
  const markerIndex = photoUrl.indexOf(marker);
  if (markerIndex >= 0) {
    return decodeURIComponent(photoUrl.slice(markerIndex + marker.length));
  }

  return photoUrl.includes('://') ? null : photoUrl;
}

async function resolvePhotoUrl(supabase, bucket, photoUrl) {
  const path = extractStoragePath(photoUrl, bucket);
  if (!path) return null;

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (error) {
    console.warn(`Unable to create signed URL for ${bucket}:`, error.message);
    return null;
  }

  return data.signedUrl;
}

// Single batched createSignedUrls call — avoids one round-trip per row in list endpoints
async function resolvePhotoUrls(supabase, bucket, rows, field = 'photo_url') {
  const paths = rows.map(r => extractStoragePath(r[field], bucket)).filter(Boolean);
  if (paths.length === 0) return rows.map(r => ({ ...r, [field]: null }));

  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, 60 * 60);
  const urlByPath = {};
  if (!error && data) {
    for (const item of data) {
      if (item.signedUrl && item.path) urlByPath[item.path] = item.signedUrl;
    }
  }

  return rows.map(r => {
    const path = extractStoragePath(r[field], bucket);
    return { ...r, [field]: (path && urlByPath[path]) || null };
  });
}

module.exports = { resolvePhotoUrl, resolvePhotoUrls, extractStoragePath };