import { Radio, Twitch, Youtube } from 'lucide-react'
import type { LivePlatform } from '../../shared/live'
import { cn } from '../lib/utils'

const TILES: Record<LivePlatform, string> = {
  twitch: 'bg-[#9146ff]/20 text-[#b98cff]',
  youtube: 'bg-[#ff0033]/15 text-[#ff5c7a]',
  kick: 'bg-[#53fc18]/15 text-[#53fc18]'
}

const NAMES: Record<LivePlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' }

/** A live platform's mark in its brand color; a neutral live mark when the platform is unknown. */
export function LivePlatformIcon({ platform, size = 'md', className }: {
  platform: LivePlatform | null
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const box = size === 'sm' ? 'h-6 w-6' : 'h-8 w-8'
  const glyph = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full', box,
      platform ? TILES[platform] : 'bg-danger/15 text-danger', className)}>
      {platform === 'twitch' ? <Twitch className={glyph} aria-label="Twitch" />
        : platform === 'youtube' ? <Youtube className={glyph} aria-label="YouTube" />
          : platform === 'kick' ? <span aria-label="Kick" className={cn('font-black leading-none', size === 'sm' ? 'text-xs' : 'text-sm')}>K</span>
            : <Radio className={glyph} aria-label="Live" />}
    </span>
  )
}

export function livePlatformName(platform: LivePlatform | null): string {
  return platform ? NAMES[platform] : 'Live'
}
