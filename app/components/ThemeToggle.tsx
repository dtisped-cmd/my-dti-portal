'use client';

import { useEffect, useRef, useState } from 'react';

const THEME_STORAGE_KEY = 'udti-theme';

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);
  const switchRef = useRef<HTMLLabelElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const soundSourcesRef = useRef<OscillatorNode[]>([]);

  const stopThemeSound = () => {
    soundSourcesRef.current.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already have finished.
      }
    });
    soundSourcesRef.current = [];
  };

  const playThemeSound = (dark: boolean) => {
    stopThemeSound();

    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;

    const audioContext = audioContextRef.current ?? new AudioContextConstructor();
    audioContextRef.current = audioContext;
    void audioContext.resume();

    const playChirps = () => {
      const notes = dark
        ? [
            { offset: 0, duration: 0.08, startHz: 4200, endHz: 4550 },
            { offset: 0.12, duration: 0.07, startHz: 4400, endHz: 4750 },
            { offset: 0.31, duration: 0.09, startHz: 4100, endHz: 4500 },
          ]
        : [
            { offset: 0, duration: 0.15, startHz: 2100, endHz: 3050 },
            { offset: 0.2, duration: 0.11, startHz: 2850, endHz: 2250 },
            { offset: 0.43, duration: 0.16, startHz: 2450, endHz: 3350 },
            { offset: 0.68, duration: 0.2, startHz: 3150, endHz: 2150 },
          ];

      notes.forEach(({ offset, duration, startHz, endHz }) => {
        const oscillator = audioContext.createOscillator();
        const volume = audioContext.createGain();
        const startAt = audioContext.currentTime + offset;

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(startHz, startAt);
        oscillator.frequency.exponentialRampToValueAtTime(endHz, startAt + duration);
        volume.gain.setValueAtTime(0.0001, startAt);
        volume.gain.linearRampToValueAtTime(dark ? 0.012 : 0.025, startAt + 0.02);
        volume.gain.linearRampToValueAtTime(0.0001, startAt + duration);
        oscillator.connect(volume);
        volume.connect(audioContext.destination);
        oscillator.onended = () => {
          soundSourcesRef.current = soundSourcesRef.current.filter((source) => source !== oscillator);
          oscillator.disconnect();
          volume.disconnect();
        };
        soundSourcesRef.current.push(oscillator);
        oscillator.start(startAt);
        oscillator.stop(startAt + duration + 0.01);
      });
    };

    playChirps();
  };

  const toggleTheme = () => {
    const toggleBounds = switchRef.current?.getBoundingClientRect();
    const originX = toggleBounds ? toggleBounds.left + toggleBounds.width / 2 : 48;
    const originY = toggleBounds ? toggleBounds.top + toggleBounds.height / 2 : 35;
    document.documentElement.style.setProperty('--theme-origin-x', `${originX}px`);
    document.documentElement.style.setProperty('--theme-origin-y', `${originY}px`);
    document.documentElement.classList.remove('theme-to-dark', 'theme-to-light');
    document.documentElement.classList.add(isDark ? 'theme-to-light' : 'theme-to-dark');
    document.documentElement.classList.add('theme-transitioning');
    playThemeSound(!isDark);
    setIsDark((prev) => !prev);
    window.setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning', 'theme-to-dark', 'theme-to-light');
    }, 850);
  };

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldUseDark = savedTheme ? savedTheme === 'dark' : prefersDark;

    setIsDark(shouldUseDark);
    document.documentElement.setAttribute('data-theme', shouldUseDark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    return () => {
      soundSourcesRef.current.forEach((source) => {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // The source may already have finished.
        }
      });
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        void audioContextRef.current.close();
      }
    };
  }, []);

  return (
    <div className="theme-toggle-wrap">
      <label ref={switchRef} className="switch" aria-label="تبديل الوضع الليلي/النهاري">
        <input
          id="input"
          type="checkbox"
          checked={isDark}
          onChange={toggleTheme}
        />
        <span className="slider round">
          <span className="sun-moon">
            <svg
              id="light-ray-1"
              viewBox="0 0 200 200"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <circle cx="100" cy="100" r="100" />
            </svg>
            <svg
              id="light-ray-2"
              viewBox="0 0 200 200"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <circle cx="100" cy="100" r="100" />
            </svg>
            <svg
              id="light-ray-3"
              viewBox="0 0 200 200"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <circle cx="100" cy="100" r="100" />
            </svg>

            <svg id="moon-dot-1" className="moon-dot" viewBox="0 0 10 10" aria-hidden="true">
              <circle cx="5" cy="5" r="2.5" />
            </svg>
            <svg id="moon-dot-2" className="moon-dot" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="3.5" />
            </svg>
            <svg id="moon-dot-3" className="moon-dot" viewBox="0 0 8 8" aria-hidden="true">
              <circle cx="4" cy="4" r="1.8" />
            </svg>

            <svg id="cloud-1" className="cloud-light" viewBox="0 0 100 50" aria-hidden="true">
              <path d="M20 42c-9 0-16-7-16-16 0-7.2 4.8-13.4 11.3-15.2A19.3 19.3 0 0 1 42 10c9.4 0 17.8 6.7 19.4 15.9C67 26 72.8 30 79 30c8.6 0 15.5 6.8 15.5 15.1S87.6 60.3 79 60.3H20z" />
            </svg>
            <svg id="cloud-2" className="cloud-dark" viewBox="0 0 100 50" aria-hidden="true">
              <path d="M20 42c-9 0-16-7-16-16 0-7.2 4.8-13.4 11.3-15.2A19.3 19.3 0 0 1 42 10c9.4 0 17.8 6.7 19.4 15.9C67 26 72.8 30 79 30c8.6 0 15.5 6.8 15.5 15.1S87.6 60.3 79 60.3H20z" />
            </svg>
            <svg id="cloud-3" className="cloud-light" viewBox="0 0 100 50" aria-hidden="true">
              <path d="M20 42c-9 0-16-7-16-16 0-7.2 4.8-13.4 11.3-15.2A19.3 19.3 0 0 1 42 10c9.4 0 17.8 6.7 19.4 15.9C67 26 72.8 30 79 30c8.6 0 15.5 6.8 15.5 15.1S87.6 60.3 79 60.3H20z" />
            </svg>

            <svg className="stars" viewBox="0 0 40 40" aria-hidden="true">
              <path id="star-1" className="star" d="M10 0l2.4 6.6L19 9l-6.6 2.4L10 18l-2.4-6.6L1 9l6.6-2.4z" />
              <path id="star-2" className="star" d="M30 10l1.2 3.2L34 14l-2.8 1.1L30 18l-1.2-2.9L26 14l2.8-1.1z" />
              <path id="star-3" className="star" d="M18 16l1.6 4.4 4.4 1.6-4.4 1.6L18 28l-1.6-4.4-4.4-1.6 4.4-1.6z" />
              <path id="star-4" className="star" d="M28 2l1.7 4.7 4.7 1.7-4.7 1.7L28 15l-1.7-4.7-4.7-1.7 4.7-1.7z" />
            </svg>
          </span>
        </span>
      </label>
    </div>
  );
}
