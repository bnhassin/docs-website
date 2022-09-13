const preferDefault = (m) => (m && m.default) || m;
const parseISO = preferDefault(require('date-fns/parseISO'));

const hasOwnProperty = (obj, key) =>
  Object.prototype.hasOwnProperty.call(obj, key);

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions;

  createTypes(`
    type Nav @dontInfer {
      id: ID!
      title(locale: String = "en"): String
      filterable: Boolean!
      url: String
      pages: [NavItem!]!
    }

    type NavItem @dontInfer {
      id: ID!
      title(locale: String = "en"): String!
      icon: String
      url: String
      pages: [NavItem!]!
    }
  `);
};

exports.createResolvers = ({ createResolvers, createNodeId }) => {
  createResolvers({
    Query: {
      nav: {
        type: 'Nav',
        args: {
          slug: 'String!',
        },
        resolve: async (_source, args, context) => {
          const { slug } = args;
          const { nodeModel } = context;

          const { entries } = await nodeModel.findAll({ type: 'Locale' });

          // Convert GatsbyIterable to array to use array methods it doesn't support
          const locales = Array.from(entries)
            .filter(({ isDefault }) => !isDefault)
            .map(({ locale }) => locale);
          const utils = {
            args,
            nodeModel,
            createNodeId,
            locales,
          };

          switch (true) {
            case slug === '/':
              return createRootNav(utils);

            case slug.startsWith('/whats-new'):
              return createWhatsNewNav(utils);

            case slug.startsWith('/docs/release-notes'):
              return createReleaseNotesNav(utils);

            default:
              return createNav(utils);
          }
        },
      },
    },
    Nav: {
      filterable: {
        resolve: (source) =>
          hasOwnProperty(source, 'filterable') ? source.filterable : true,
      },
      url: {
        resolve: (source) => source.url || source.path,
      },
      title: {
        resolve: findTranslatedTitle,
      },
    },
    NavItem: {
      title: {
        resolve: findTranslatedTitle,
      },
      url: {
        resolve: (source) => source.url || source.path,
      },
      pages: {
        resolve: (source) => source.pages || [],
      },
    },
  });
};

exports.onCreatePage = ({ page, actions }) => {
  const { createPage } = actions;

  if (!page.context.slug) {
    page.context.slug = page.path;

    createPage(page);
  }
};

const createRootNav = async ({ args, createNodeId, nodeModel }) => {
  const { slug } = args;

  const { entries } = await nodeModel.findAll({ type: 'NavYaml' });

  // Convert GatsbyIterable to array to use array methods it doesn't support
  const rootNavYamlNode = Array.from(entries.filter((node) => node.rootNav));
  const nav = rootNavYamlNode.find((nav) => findPage(nav, slug));

  if (!nav) {
    return null;
  }

  return {
    ...nav,
    id: createNodeId('root'),
  };
};

const createWhatsNewNav = async ({ createNodeId, nodeModel }) => {
  const { entries } = await nodeModel.findAll({
    type: 'MarkdownRemark',
    query: {
      filter: {
        fileAbsolutePath: {
          regex: '/src/content/whats-new/',
        },
      },
      sort: {
        fields: ['frontmatter.releaseDate', 'frontmatter.title'],
        order: ['DESC', 'ASC'],
      },
    },
  });

  const posts = Array.from(entries);

  const currentYear = new Date().getFullYear();
  const postsByYear = groupBy(posts, (post) => parseDate(post).getFullYear());
  const thisYearsPosts = postsByYear.get(currentYear) || [];

  const postsByMonth = groupBy(thisYearsPosts, (post) =>
    parseDate(post).toLocaleString('default', { month: 'long' })
  );

  const previousYearsPosts = Array.from(postsByYear.entries()).filter(
    ([year]) => year < currentYear
  );

  const navItems = Array.from(postsByMonth.entries())
    .concat(previousYearsPosts)
    .map(([key, posts]) => ({ title: key, pages: formatPosts(posts) }))
    .filter(({ pages }) => pages.length);

  return {
    id: createNodeId('whats-new'),
    title: "What's new",
    pages: [{ title: 'Overview', url: '/whats-new' }].concat(navItems),
  };
};

const createReleaseNotesNav = async ({ createNodeId, nodeModel }) => {
  const [
    { entries: releaseNoteEntries },
    { entries: landingPagesEntries },
  ] = await Promise.all([
    nodeModel.findAll({
      type: 'Mdx',
      query: {
        filter: {
          fileAbsolutePath: {
            regex: '/src/content/docs/release-notes/.*(?<!index).mdx/',
          },
        },
        sort: {
          fields: ['frontmatter.releaseDate'],
          order: ['DESC'],
        },
      },
    }),

    nodeModel.findAll({
      type: 'Mdx',
      query: {
        filter: {
          fileAbsolutePath: {
            regex: '/src/content/docs/release-notes/.*/index.mdx$/',
          },
        },
      },
    }),
  ]);

  // Convert GatsbyIterable to array to use array methods it doesn't support
  const posts = Array.from(releaseNoteEntries);
  const landingPages = Array.from(landingPagesEntries);

  const subjects = posts
    .reduce((acc, curr) => [...new Set([...acc, curr.frontmatter.subject])], [])
    .filter(Boolean)
    .sort((a, b) =>
      a
        .toLowerCase()
        .replace(/\W/, '')
        .localeCompare(b.toLowerCase().replace(/\W/, ''))
    );

  const formatReleaseNotePosts = (posts) =>
    posts.map((post) => {
      const derivedTitle = post.frontmatter.version
        ? `${post.frontmatter.subject} v${post.frontmatter.version}`
        : post.frontmatter.subject;

      return {
        title: post.frontmatter.title ? post.frontmatter.title : derivedTitle,
        url: post.fields.slug,
        pages: [],
      };
    });

  const filterBySubject = (subject, posts) =>
    posts.filter((post) => post.frontmatter.subject === subject);

  return {
    id: createNodeId('release-notes'),
    title: 'Release Notes',
    pages: [{ title: 'Overview', url: '/docs/release-notes' }].concat(
      subjects.map((subject) => {
        const landingPage = landingPages.find(
          (page) => page.frontmatter.subject === subject
        );

        return {
          title: subject,
          url: landingPage && landingPage.fields.slug,
          pages: formatReleaseNotePosts(filterBySubject(subject, posts)),
        };
      })
    ),
  };
};

const parseDate = (post) => parseISO(post.frontmatter.releaseDate);

const formatPosts = (posts) =>
  posts.map((post) => ({
    title: post.frontmatter.title,
    url: post.fields.slug,
    pages: [],
  }));

const groupBy = (arr, fn) =>
  arr.reduce((map, item) => {
    const key = fn(item);

    return map.set(key, [...(map.get(key) || []), item]);
  }, new Map());

const createNav = async ({ args, createNodeId, nodeModel, locales }) => {
  let { slug } = args;
  slug = slug
    .replace(/\/table-of-contents$/, '')
    .replace(new RegExp(`^\\/(${locales.join('|')})(?=\\/)`), '');

  const { entries } = await nodeModel.findAll({ type: 'NavYaml' });

  const allNavYamlNodes = Array.from(entries)
    .filter((node) => !node.rootNav)
    .sort((a, b) => a.title.localeCompare(b.title));

  let nav =
    allNavYamlNodes.find((nav) => findPage(nav, slug)) ||
    allNavYamlNodes.find((nav) => slug.includes(nav.path));

  const trueNav = allNavYamlNodes.find((nav) => slug.includes(nav.path));

  if (!nav) {
    return null;
  }

  // if current is link to auto index page && its path does not
  // belong to nav it was first found in, find nav that matches its path
  if (trueNav && trueNav !== nav) {
    nav = trueNav;
  }

  return {
    ...nav,
    id: createNodeId(nav.title),
  };
};

const findTranslatedTitle = async (source, args, { nodeModel }) => {
  if (args.locale === 'en') {
    return source.title;
  }

  const item = await nodeModel.findOne({
    type: 'TranslatedNavJson',
    query: {
      filter: {
        locale: { eq: args.locale },
        englishTitle: { eq: source.title },
      },
    },
  });

  return item ? item.title : source.title;
};

const findPage = (page, path) => {
  if (page.path === path) {
    return page;
  }

  if (page.pages == null || page.pages.length === 0) {
    return null;
  }

  return page.pages.find((child) => findPage(child, path));
};
