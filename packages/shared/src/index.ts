import { z } from 'zod';

export const orderItemSchema = z.object({
  menu_item_id: z.string().uuid().optional(),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  options: z.array(z.object({ name: z.string(), value: z.string() })).default([])
});

export const aiOrderOutputSchema = z.object({
  customer_name: z.string().optional(),
  customer_phone: z.string().min(7),
  pickup_time: z.string().min(2),
  items: z.array(orderItemSchema).min(1),
  special_instructions: z.string().optional(),
  subtotal: z.number().nonnegative(),
  tax: z.number().nonnegative().default(0),
  total: z.number().nonnegative(),
  confidence: z.number().min(0).max(1)
});

export const updateMenuSchema = z.object({
  menu_json: z.object({
    categories: z.array(
      z.object({
        name: z.string().min(1),
        items: z.array(
          z.object({
            id: z.string().optional(),
            name: z.string().min(1),
            description: z.string().optional(),
            price: z.number().nonnegative(),
            options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([])
          })
        )
      })
    )
  })
});

export const createOrderBodySchema = z.object({
  restaurant_id: z.string().uuid(),
  transcript: z.string().default(''),
  ai_output: aiOrderOutputSchema
});

export const orderStatusSchema = z.enum(['pending', 'confirmed', 'completed', 'cancelled']);

export type AIOrderOutput = z.infer<typeof aiOrderOutputSchema>;
export type UpdateMenuBody = z.infer<typeof updateMenuSchema>;
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;
