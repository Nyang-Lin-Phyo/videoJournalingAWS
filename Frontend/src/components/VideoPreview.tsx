import { useState } from "react";
import { Icon } from "./Icon";
export function VideoPreview({
  src,
  demo = false,
}: {
  src: string | null;
  demo?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="video-preview">
      {src && (
        <video
          aria-label="Journal video"
          src={src}
          controls
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
        />
      )}
      {!src && (
        <div className="video-placeholder">
          <Icon name="video" size={38} />
          <h3>
            {demo ? "An example, just for you" : "Your video will appear here"}
          </h3>
          <p>
            {demo
              ? "This synthetic entry has no recording. Upload an MP4 to try playback in this session."
              : "Choose an MP4 to preview it before uploading."}
          </p>
        </div>
      )}
      {failed && (
        <p className="video-error" role="status">
          This video could not be played. Your browser may not support its
          codecs, or the video server may be unavailable.
        </p>
      )}
    </div>
  );
}
