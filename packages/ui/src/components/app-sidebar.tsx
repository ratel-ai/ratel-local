"use client";

import {
  BotIcon,
  BoxesIcon,
  GalleryVerticalEndIcon,
  KeyRoundIcon,
  LinkIcon,
  Settings2Icon,
  TerminalSquareIcon,
} from "lucide-react";
import type * as React from "react";
import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";

// This is sample data.
const data = {
  user: {
    name: "Ratel",
    email: "gateway@local",
    avatar: "/avatars/shadcn.jpg",
  },
  teams: [
    {
      name: "Ratel Local",
      logo: <GalleryVerticalEndIcon />,
      plan: "Gateway",
    },
    {
      name: "Claude Code",
      logo: <BotIcon />,
      plan: "Agent",
    },
    {
      name: "Codex",
      logo: <TerminalSquareIcon />,
      plan: "Agent",
    },
  ],
  navMain: [
    {
      title: "Servers",
      url: "#",
      icon: <BoxesIcon />,
      isActive: true,
      items: [
        {
          title: "User scope",
          url: "#",
        },
        {
          title: "Project scope",
          url: "#",
        },
        {
          title: "Local overrides",
          url: "#",
        },
      ],
    },
    {
      title: "Auth",
      url: "#",
      icon: <KeyRoundIcon />,
      items: [
        {
          title: "OAuth sessions",
          url: "#",
        },
        {
          title: "Expired tokens",
          url: "#",
        },
        {
          title: "Providers",
          url: "#",
        },
      ],
    },
    {
      title: "Agent Links",
      url: "#",
      icon: <LinkIcon />,
      items: [
        {
          title: "Claude",
          url: "#",
        },
        {
          title: "Codex",
          url: "#",
        },
        {
          title: "Import plan",
          url: "#",
        },
      ],
    },
    {
      title: "Settings",
      url: "#",
      icon: <Settings2Icon />,
      items: [
        {
          title: "General",
          url: "#",
        },
        {
          title: "Team",
          url: "#",
        },
        {
          title: "Billing",
          url: "#",
        },
        {
          title: "Limits",
          url: "#",
        },
      ],
    },
  ],
  projects: [
    {
      name: "Filesystem",
      url: "#",
      icon: <BoxesIcon />,
    },
    {
      name: "GitHub",
      url: "#",
      icon: <KeyRoundIcon />,
    },
    {
      name: "Playwright",
      url: "#",
      icon: <TerminalSquareIcon />,
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavProjects projects={data.projects} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
