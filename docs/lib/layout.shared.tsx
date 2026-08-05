import {
  DiscordLogoIcon,
  GithubLogoIcon,
  XLogoIcon,
} from "@phosphor-icons/react/ssr";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-1 font-semibold">
          <img
            className="skillplane-logo"
            src="/docs/skillplane-logo-gradient-transparent.png"
            alt=""
            aria-hidden="true"
            width={512}
            height={512}
            draggable={false}
          />
          Skillplane
        </span>
      ),
      url: "https://skillplane.dev",
    },
    links: [
      {
        text: "GitHub",
        url: "https://github.com/21nCo/skillplane",
        external: true,
      },
      {
        text: "Open Skillplane",
        url: "https://app.skillplane.dev",
        external: true,
      },
      {
        type: "icon",
        label: "Skillplane on X",
        text: "X",
        url: "https://x.com/skillplane",
        external: true,
        icon: <XLogoIcon size={18} weight="regular" aria-hidden="true" />,
      },
      {
        type: "icon",
        label: "Join Skillplane on Discord",
        text: "Discord",
        url: "https://discord.com/invite/9HJqKYTZKg",
        external: true,
        icon: <DiscordLogoIcon size={18} weight="regular" aria-hidden="true" />,
      },
      {
        type: "icon",
        label: "Skillplane on GitHub",
        text: "GitHub",
        url: "https://github.com/21nCo/skillplane",
        external: true,
        icon: <GithubLogoIcon size={18} weight="regular" aria-hidden="true" />,
      },
    ],
  };
}
