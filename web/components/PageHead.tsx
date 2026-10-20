// Per-page <head> tags, the same set and wording the old static pages had. React 19 hoists <title>, <meta> and <link> into
// <head> wherever they are rendered. Stylesheets carry `precedence`, so React keeps them in <head> in first-seen order: the
// root layout's fonts and veyl.css first, then any page stylesheet (app.css), so the cascade is unchanged.
const OG_IMAGE_ALT = 'The Veyl mark beside the line: Liquidity, without a name.';
export default function PageHead({ title, description, ogTitle = title, ogDescription = description, styles = [] }:
  { title: string; description: string; ogTitle?: string; ogDescription?: string; styles?: string[] }) {
  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta property="og:title" content={ogTitle} />
      <meta property="og:description" content={ogDescription} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Veyl" />
      <meta property="og:image" content="brand/og.png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={OG_IMAGE_ALT} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={ogTitle} />
      <meta name="twitter:description" content={ogDescription} />
      <meta name="twitter:image" content="brand/og.png" />
      {styles.map((href) => <link key={href} rel="stylesheet" href={href} precedence="veyl-page" />)}
    </>
  );
}
