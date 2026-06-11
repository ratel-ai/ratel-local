import { cn } from "@/lib/utils";

export const brandLogoSources = {
  greenCream: "/brand/ratel-green-cream.png",
  green: "/brand/ratel-green.png",
  cream: "/brand/ratel-cream.svg",
  azureCream: "/brand/ratel-azure-cream.png",
  orangeCream: "/brand/ratel-orange-cream.png",
} as const;

export type BrandLogoVariant = keyof typeof brandLogoSources;

export function BrandLogo({
  alt = "Ratel",
  className,
  variant = "greenCream",
}: {
  alt?: string;
  className?: string;
  variant?: BrandLogoVariant;
}) {
  return (
    <img
      alt={alt}
      className={cn("block h-auto max-w-full object-contain", className)}
      src={brandLogoSources[variant]}
    />
  );
}
