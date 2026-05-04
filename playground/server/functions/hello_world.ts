export default defineFunction({
    description: 'A simple function that returns a greeting message.',
    triggers: [
        {
            type: 'http',
            config: {
                api_path: '/hello',
                http_method: 'GET',
            },
        },
    ],
    handler: async () => {
        return {
            status: 200,
            body: {
                message: 'Hello, world!',
            },
        }
    }
})