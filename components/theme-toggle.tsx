'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import styles from './theme-toggle.module.css';

const subscribe = () => () => {};
const mountedSnapshot = () => true;
const serverSnapshot = () => false;

export function ThemeToggle() {
  const mounted = useSyncExternalStore(subscribe, mountedSnapshot, serverSnapshot);
  const { resolvedTheme, setTheme } = useTheme();
  const nextTheme = mounted && resolvedTheme === 'light' ? 'dark' : 'light';
  const label = `Switch to ${nextTheme} mode`;
  const Icon = nextTheme === 'light' ? Sun : Moon;

  return (
    <button
      className={styles.toggle}
      type="button"
      aria-label={label}
      title={label}
      disabled={!mounted}
      onClick={() => setTheme(nextTheme)}
    >
      <Icon size={15} aria-hidden="true" />
      <span className={styles.label}>{nextTheme === 'light' ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}
