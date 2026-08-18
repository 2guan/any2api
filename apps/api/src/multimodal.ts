export function extractMessageContent(rawContent: unknown): { text: string; images: string[] } {
  let content = rawContent;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        content = JSON.parse(trimmed);
      } catch {
        /* Keep original string */
      }
    }
  }

  const textParts: string[] = [];
  const imageParts: string[] = [];

  const processItem = (item: unknown) => {
    if (!item) return;
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.startsWith('data:image/') || /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|bmp|svg)/i.test(trimmed)) {
        imageParts.push(trimmed);
        return;
      }
      const mdImgRegex = /!\[.*?\]\((data:image\/[a-zA-Z0-9+.-]+;base64,[^\s)]+|https?:\/\/[^\s)]+)\)/g;
      let match: RegExpExecArray | null;
      let lastIdx = 0;
      while ((match = mdImgRegex.exec(item)) !== null) {
        textParts.push(item.slice(lastIdx, match.index));
        imageParts.push(match[1]);
        lastIdx = mdImgRegex.lastIndex;
      }
      textParts.push(item.slice(lastIdx));
      return;
    }

    if (typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const type = String(obj.type || '').toLowerCase().replace(/[_-]/g, '');

      if (type === 'text' || typeof obj.text === 'string') {
        if (typeof obj.text === 'string') textParts.push(obj.text);
      }

      let imgUrl = '';
      if (typeof obj.image_url === 'string') imgUrl = obj.image_url;
      else if (typeof (obj.image_url as { url?: string })?.url === 'string') imgUrl = (obj.image_url as { url: string }).url;
      else if (typeof obj.imageurl === 'string') imgUrl = obj.imageurl;
      else if (typeof (obj.imageurl as { url?: string })?.url === 'string') imgUrl = (obj.imageurl as { url: string }).url;
      else if (typeof obj.url === 'string') imgUrl = obj.url;
      else if (typeof obj.image === 'string') imgUrl = obj.image;
      else if (obj.source && typeof obj.source === 'object') {
        const src = obj.source as { data?: string; media_type?: string };
        if (src.data) imgUrl = `data:${src.media_type || 'image/png'};base64,${src.data}`;
      }

      if (imgUrl) {
        imageParts.push(imgUrl);
      } else if (!type && typeof obj.content === 'string') {
        processItem(obj.content);
      }
    }
  };

  if (Array.isArray(content)) {
    for (const item of content) processItem(item);
  } else {
    processItem(content);
  }

  return {
    text: textParts.join('').trim(),
    images: imageParts
  };
}

export function extractConversationContent(messages: Array<{ role: string; content: unknown }>): {
  systemPrompt: string;
  latestText: string;
  allText: string;
  images: string[];
} {
  let systemPrompt = '';
  const allTextLines: string[] = [];
  const allImages: string[] = [];
  let latestUserText = '';

  for (const msg of messages) {
    const { text, images } = extractMessageContent(msg.content);
    if (msg.role === 'system') {
      if (text) systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
    } else {
      if (text) {
        allTextLines.push(`${msg.role}: ${text}`);
        if (msg.role === 'user') latestUserText = text;
      }
      if (images.length > 0) {
        allImages.push(...images);
      }
    }
  }

  return {
    systemPrompt,
    latestText: latestUserText || allTextLines.at(-1) || '',
    allText: allTextLines.join('\n'),
    images: allImages
  };
}
