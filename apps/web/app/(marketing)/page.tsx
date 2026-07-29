import { Hero } from "./Hero";
import { AgentFlow } from "./AgentFlow";
import { Features } from "./Features";
import { Collaboration } from "./Collaboration";
import { Wedge } from "./Wedge";
import { CTA } from "./CTA";

const BASE_URL = "https://projectcontext.co";

const organization = {
  "@type": "Organization",
  "@id": `${BASE_URL}/#organization`,
  name: "project context",
  url: BASE_URL,
  logo: {
    "@type": "ImageObject",
    url: `${BASE_URL}/og-image.png`,
    width: 1200,
    height: 630,
  },
  sameAs: [
    "https://twitter.com/projectcontext",
    "https://linkedin.com/company/projectcontext",
    "https://github.com/projectcontext",
  ],
};

const softwareApplication = {
  "@type": "SoftwareApplication",
  "@id": `${BASE_URL}/#software`,
  name: "project context",
  alternateName: "projectcontext.co",
  url: BASE_URL,
  description:
    "project context is an AI-powered engineering workspace that gives your team a coordinated team of AI specialists — Product Manager, Analyst, Project Manager, Tech Lead, and Architect — that plan, write, and execute alongside your engineering team. Turn a one-line idea into a reviewed PRD, a sequenced roadmap, and a board full of tasks.",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Project Management Software",
  operatingSystem: "Web",
  inLanguage: "en",
  featureList: [
    "AI Product Manager agent for discovery and vision",
    "AI Analyst agent for PRD and requirements writing",
    "AI Project Manager agent for roadmap and milestone sequencing",
    "AI Tech Lead agent for task breakdown and board population",
    "AI Architect agent grounded in your codebase",
    "Real-time agent orchestration via WebSocket",
    "Persistent agent memory per workspace",
    "Built-in output scoring and evaluation",
    "Knowledge base with retrieval-augmented generation",
    "Smart model routing between fast and deep models",
    "MCP tool integrations (Gmail, GitHub, Jira, Google Workspace)",
    "Multi-tenant SaaS with role-based access control",
  ],
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free to start",
  },
  creator: { "@id": `${BASE_URL}/#organization` },
};

const website = {
  "@type": "WebSite",
  "@id": `${BASE_URL}/#website`,
  url: BASE_URL,
  name: "project context",
  description: "Your AI engineering team, shipping with you.",
  publisher: { "@id": `${BASE_URL}/#organization` },
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${BASE_URL}/auth/signup?ref={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
};

const faqPage = {
  "@type": "FAQPage",
  "@id": `${BASE_URL}/#faq`,
  mainEntity: [
    {
      "@type": "Question",
      name: "What is project context?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "project context (projectcontext.co) is an AI-powered engineering workspace that provides a coordinated team of AI specialists — a Product Manager, Analyst, Project Manager, Tech Lead, and Architect — that work alongside your engineering team. It turns a one-line idea into a reviewed PRD, a sequenced roadmap, and a board full of tasks in an afternoon rather than a quarter.",
      },
    },
    {
      "@type": "Question",
      name: "How does project context work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Each AI specialist in project context runs a deterministic workflow: the Product Manager captures intent, the Analyst drafts a complete PRD, the Project Manager sequences 3–7 milestones, the Tech Lead breaks each milestone into concrete tasks, and the Architect answers architecture questions grounded in your actual codebase. Every output is human-gated before the next phase begins. Agents share persistent memory across sessions.",
      },
    },
    {
      "@type": "Question",
      name: "What AI agents does project context include?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "project context currently includes five AI agents: (1) Product Manager — captures intent and orchestrates the team; (2) Analyst — writes complete PRDs with problem, goals, user stories, and success metrics; (3) Project Manager — sequences milestones with priorities and dependencies; (4) Tech Lead — decomposes milestones into board-ready tasks with acceptance criteria and effort estimates; (5) Architect — answers codebase questions with citations, never bluffs. Code Reviewer, Data Analyst, ML Specialist, QA Engineer, and Security Auditor are coming soon.",
      },
    },
    {
      "@type": "Question",
      name: "How is project context different from GitHub Copilot or ChatGPT?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "project context is a multi-agent team, not a single chat assistant. Each specialist has its own role, tools, and deterministic workflow. Outputs are artifacts (PRDs, roadmaps, task boards) not chat transcripts. Agents are grounded in your knowledge base and codebase — the Architect cites actual files and refuses to guess. Every output is scored for completeness and quality. It's an engineering process, not a prompt.",
      },
    },
    {
      "@type": "Question",
      name: "What integrations does project context support?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "project context supports integrations with Gmail, GitHub, Jira, Google Workspace, and Zoho via MCP (Model Context Protocol). The platform is built on an open MCP server, making it extensible for custom tool integrations.",
      },
    },
    {
      "@type": "Question",
      name: "Is project context free?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes, project context is free to start. Sign up at projectcontext.co/auth/signup to bring your AI engineering team online.",
      },
    },
  ],
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [organization, softwareApplication, website, faqPage],
};

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Hero />
      <AgentFlow />
      <Features />
      <Collaboration />
      <Wedge />
      <CTA />
    </>
  );
}
