import { useRef, useState } from 'react';
import tourVideo from './media/aelionbot-tour.mp4';
import tourPoster from './media/aelionbot-tour-poster.webp';
import './video.css';

export interface VideoCopy {
  kicker: string;
  title: string;
  description: string;
  play: string;
  duration: string;
  note: string;
}

/** The product tour. Nothing is downloaded until the visitor presses play; then the video plays in place. */
export function VideoSection({ copy }: { copy: VideoCopy }) {
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  return (
    <section className="tour shell" id="tour" aria-labelledby="tour-title">
      <div className="section-head centered" data-reveal>
        <p className="kicker">{copy.kicker}</p>
        <h2 id="tour-title" className="display">
          {copy.title}
        </h2>
        <p className="serif-lead">{copy.description}</p>
      </div>
      <figure className="tour-frame" data-reveal data-delay="1">
        {playing ? (
          <video
            ref={video}
            className="tour-video"
            src={tourVideo}
            poster={tourPoster}
            controls
            autoPlay
            playsInline
            preload="auto"
            aria-label={copy.title}
          />
        ) : (
          <button type="button" className="tour-poster" onClick={() => setPlaying(true)} aria-label={copy.play}>
            <img src={tourPoster} alt="" width={1280} height={720} loading="lazy" decoding="async" />
            <span className="tour-play" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26">
                <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
              </svg>
            </span>
            <span className="tour-label">
              {copy.play}
              <small>{copy.duration}</small>
            </span>
          </button>
        )}
        <figcaption className="fine-print">{copy.note}</figcaption>
      </figure>
    </section>
  );
}
