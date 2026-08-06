# Jira Mock Design System

## Overview

Jira Mock is a compact developer inspector. The interface prioritizes current state, scanning speed, and API-shaped detail. It uses a restrained light theme and familiar product controls rather than reproducing Jira or adopting a terminal aesthetic.

## Color

All implementation colors use OKLCH.

- Background: `oklch(1 0 0)`
- Surface: `oklch(0.965 0.004 50)`
- Elevated surface: `oklch(0.985 0.002 50)`
- Ink: `oklch(0.19 0.018 50)`
- Muted ink: `oklch(0.49 0.022 50)`
- Border: `oklch(0.89 0.008 50)`
- Primary: `oklch(0.50 0.135 45)`
- Primary tint: `oklch(0.965 0.025 45)`
- Focus/link: `oklch(0.40 0.12 235)`
- Success: `oklch(0.48 0.12 150)`
- Danger: `oklch(0.52 0.18 25)`

Color is functional. Burnt orange marks selection and primary actions, blue marks links and keyboard focus, and semantic colors always appear with text or an icon.

## Typography

- Product text: system UI sans-serif stack
- Issue keys, API routes, and raw values: system monospace stack
- Fixed product scale: 0.75rem, 0.8125rem, 0.875rem, 1rem, 1.25rem
- Use tabular numerals for counts, dates, and pagination

## Layout

- Desktop: project rail, issue workspace, and issue inspector
- Tablet: project rail collapses; project selection remains in the filter bar
- Mobile: single-column issue list with a full-width issue inspector
- Base spacing scale: 4, 8, 12, 16, 24, 32px
- Dividers and proximity create grouping; cards are reserved for distinct comment records and error states

## Components

- Controls use 8px radii; panels use no more than 12px
- Interactive targets are at least 44px on coarse pointers
- Every control has hover, focus-visible, active, disabled, loading, error, and success treatment where applicable
- Tables use semantic markup and remain horizontally scrollable before columns are progressively hidden
- Destructive reset uses a native confirmation dialog

## Motion

Motion communicates state only and stays between 150–220ms. The mobile inspector slides into view. Toasts and loading transitions crossfade. Reduced-motion users receive immediate state changes.
