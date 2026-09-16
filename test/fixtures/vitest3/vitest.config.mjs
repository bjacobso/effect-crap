export default {
  test: {
    include: ["callbacks.test.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["json"] },
  },
};
