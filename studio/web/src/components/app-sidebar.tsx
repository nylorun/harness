import * as React from "react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"

const data = {
  sections: [
    {
      title: "Getting Started",
      items: [
        {
          title: "Agent Server",
          url: "#",
          isActive: true,
        },
        {
          title: "Studio configuration",
          url: "#",
        },
      ],
    },
    {
      title: "Development",
      items: [
        {
          title: "Sessions",
          url: "#",
        },
        {
          title: "Runs",
          url: "#",
        },
        {
          title: "Events",
          url: "#",
        },
        {
          title: "Inspector",
          url: "#",
        },
      ],
    },
    {
      title: "Reference",
      items: [
        {
          title: "Direct browser access",
          url: "#",
        },
        {
          title: "CORS",
          url: "#",
        },
      ],
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Studio contents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {data.sections.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton className="pointer-events-none font-medium">
                    {item.title}
                  </SidebarMenuButton>
                  {item.items?.length ? (
                    <SidebarMenuSub>
                      {item.items.map((item) => (
                        <SidebarMenuSubItem key={item.title}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={item.isActive}
                          >
                            <a href={item.url}>{item.title}</a>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
